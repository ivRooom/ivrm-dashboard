create or replace function public.enqueue_operation_job(
  p_host_id uuid,
  p_operation_type text,
  p_payload jsonb,
  p_requested_by uuid,
  p_requested_email text,
  p_idempotency_key_hash text,
  p_confirmation_verified boolean,
  p_request_id uuid,
  p_actor_ip inet default null
)
returns table (
  job_id uuid,
  outcome text,
  job_status text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor public.console_users%rowtype;
  v_existing public.operation_jobs%rowtype;
  v_conflicting public.operation_jobs%rowtype;
  v_job public.operation_jobs%rowtype;
  v_lock_scope text;
  v_required_rank integer;
  v_actor_rank integer;
  v_confirmation_required boolean;
begin
  if p_host_id is null
    or p_operation_type is null
    or p_requested_by is null
    or p_request_id is null then
    raise exception 'operation_request_required_field_missing'
      using errcode = '22023';
  end if;

  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or p_payload <> '{}'::jsonb then
    raise exception 'operation_payload_not_allowed'
      using errcode = '22023';
  end if;

  if p_idempotency_key_hash is null
    or p_idempotency_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'operation_idempotency_hash_invalid'
      using errcode = '22023';
  end if;

  select *
    into v_actor
    from public.console_users
    where id = p_requested_by
    for share;

  if not found
    or not v_actor.is_active
    or v_actor.email <> lower(btrim(p_requested_email)) then
    raise exception 'operation_actor_invalid'
      using errcode = '42501';
  end if;

  case v_actor.role
    when 'viewer' then v_actor_rank := 0;
    when 'operator' then v_actor_rank := 1;
    when 'administrator' then v_actor_rank := 2;
    when 'owner' then v_actor_rank := 3;
    else raise exception 'operation_actor_role_invalid' using errcode = '42501';
  end case;

  case p_operation_type
    when 'save_world' then
      v_lock_scope := 'minecraft:world';
      v_required_rank := 1;
      v_confirmation_required := false;
    when 'restart_backend' then
      v_lock_scope := 'minecraft:exclusive';
      v_required_rank := 1;
      v_confirmation_required := true;
    when 'restart_proxy' then
      v_lock_scope := 'minecraft:exclusive';
      v_required_rank := 2;
      v_confirmation_required := true;
    when 'start_backend' then
      v_lock_scope := 'minecraft:exclusive';
      v_required_rank := 1;
      v_confirmation_required := false;
    when 'stop_backend' then
      v_lock_scope := 'minecraft:exclusive';
      v_required_rank := 2;
      v_confirmation_required := true;
    when 'maintenance_start' then
      v_lock_scope := 'minecraft:maintenance';
      v_required_rank := 1;
      v_confirmation_required := false;
    when 'maintenance_end' then
      v_lock_scope := 'minecraft:maintenance';
      v_required_rank := 1;
      v_confirmation_required := false;
    when 'create_backup' then
      v_lock_scope := 'minecraft:exclusive';
      v_required_rank := 1;
      v_confirmation_required := false;
    when 'verify_backup' then
      v_lock_scope := 'minecraft:exclusive';
      v_required_rank := 1;
      v_confirmation_required := false;
    else
      raise exception 'operation_type_not_allowed'
        using errcode = '22023';
  end case;

  if v_actor_rank < v_required_rank then
    perform public.append_audit_log(
      p_request_id,
      v_actor.id,
      v_actor.email,
      v_actor.role,
      p_actor_ip,
      'OPERATION_REQUEST_DENIED',
      'operation_job',
      null,
      'denied',
      jsonb_build_object('operationType', p_operation_type)
    );

    return query
      select null::uuid, 'denied'::text, null::text;
    return;
  end if;

  if v_confirmation_required and not coalesce(p_confirmation_verified, false) then
    perform public.append_audit_log(
      p_request_id,
      v_actor.id,
      v_actor.email,
      v_actor.role,
      p_actor_ip,
      'OPERATION_CONFIRMATION_DENIED',
      'operation_job',
      null,
      'denied',
      jsonb_build_object('operationType', p_operation_type)
    );

    return query
      select null::uuid, 'denied'::text, null::text;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_host_id::text || ':' || v_lock_scope, 0)
  );

  select *
    into v_existing
    from public.operation_jobs
    where requested_by = v_actor.id
      and host_id = p_host_id
      and operation_type = p_operation_type
      and idempotency_key_hash = p_idempotency_key_hash;

  if found then
    perform public.append_audit_log(
      p_request_id,
      v_actor.id,
      v_actor.email,
      v_actor.role,
      p_actor_ip,
      'OPERATION_REQUEST_REPLAYED',
      'operation_job',
      v_existing.id::text,
      'success',
      jsonb_build_object(
        'operationType', p_operation_type,
        'status', v_existing.status
      )
    );

    return query select v_existing.id, 'existing'::text, v_existing.status;
    return;
  end if;

  select *
    into v_conflicting
    from public.operation_jobs
    where host_id = p_host_id
      and lock_scope = v_lock_scope
      and status in ('queued', 'leased', 'running')
    order by created_at
    limit 1;

  if found then
    perform public.append_audit_log(
      p_request_id,
      v_actor.id,
      v_actor.email,
      v_actor.role,
      p_actor_ip,
      'OPERATION_REQUEST_CONFLICT',
      'operation_job',
      v_conflicting.id::text,
      'conflict',
      jsonb_build_object(
        'operationType', p_operation_type,
        'conflictingOperationType', v_conflicting.operation_type,
        'conflictingStatus', v_conflicting.status
      )
    );

    return query select v_conflicting.id, 'conflict'::text, v_conflicting.status;
    return;
  end if;

  insert into public.operation_jobs (
    host_id,
    operation_type,
    lock_scope,
    payload,
    requested_by,
    requested_email,
    requested_role,
    idempotency_key_hash,
    confirmation_verified,
    request_id
  ) values (
    p_host_id,
    p_operation_type,
    v_lock_scope,
    p_payload,
    v_actor.id,
    v_actor.email,
    v_actor.role,
    p_idempotency_key_hash,
    coalesce(p_confirmation_verified, false),
    p_request_id
  )
  returning * into v_job;

  insert into public.operation_events (
    job_id,
    event_type,
    previous_status,
    new_status,
    actor_type,
    actor_user_id,
    details
  ) values (
    v_job.id,
    'requested',
    null,
    'queued',
    'console_user',
    v_actor.id,
    jsonb_build_object('operationType', p_operation_type)
  );

  perform public.append_audit_log(
    p_request_id,
    v_actor.id,
    v_actor.email,
    v_actor.role,
    p_actor_ip,
    'OPERATION_REQUESTED',
    'operation_job',
    v_job.id::text,
    'success',
    jsonb_build_object(
      'operationType', p_operation_type,
      'status', v_job.status,
      'lockScope', v_job.lock_scope
    )
  );

  return query select v_job.id, 'created'::text, v_job.status;
end;
$$;

revoke all on function public.enqueue_operation_job(
  uuid,
  text,
  jsonb,
  uuid,
  text,
  text,
  boolean,
  uuid,
  inet
) from public, anon, authenticated;

grant execute on function public.enqueue_operation_job(
  uuid,
  text,
  jsonb,
  uuid,
  text,
  text,
  boolean,
  uuid,
  inet
) to service_role;
