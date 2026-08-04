alter table public.operation_events
  drop constraint operation_events_type_check;

alter table public.operation_events
  add constraint operation_events_type_check check (
    event_type in (
      'requested',
      'leased',
      'lease_renewed',
      'started',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'requeued'
    )
  );

create or replace function public.append_audit_log(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_ip inet,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_result text,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_previous_hash text;
  v_entry_hash text;
  v_occurred_at timestamptz := clock_timestamp();
  v_log_id bigint;
  v_canonical text;
begin
  if p_request_id is null then
    raise exception 'audit_request_id_required' using errcode = '22023';
  end if;

  if p_action is null
    or char_length(p_action) not between 1 and 120
    or p_action !~ '^[A-Z0-9_]+$' then
    raise exception 'audit_action_invalid' using errcode = '22023';
  end if;

  if p_target_type is null
    or char_length(p_target_type) not between 1 and 120
    or p_target_type !~ '^[a-z0-9:_-]+$' then
    raise exception 'audit_target_type_invalid' using errcode = '22023';
  end if;

  if p_result is null
    or p_result not in ('success', 'denied', 'conflict', 'error') then
    raise exception 'audit_result_invalid' using errcode = '22023';
  end if;

  if p_metadata is null
    or jsonb_typeof(p_metadata) <> 'object'
    or octet_length(p_metadata::text) > 8192
    or public.jsonb_contains_sensitive_key(p_metadata) then
    raise exception 'audit_metadata_invalid' using errcode = '22023';
  end if;

  select last_entry_hash
    into v_previous_hash
    from public.audit_log_chain_state
    where singleton = true
    for update;

  v_canonical := jsonb_build_object(
    'requestId', p_request_id,
    'actorUserId', p_actor_user_id,
    'actorEmail', p_actor_email,
    'actorRole', p_actor_role,
    'actorIp', p_actor_ip,
    'action', p_action,
    'targetType', p_target_type,
    'targetId', p_target_id,
    'result', p_result,
    'metadata', p_metadata,
    'occurredAt', to_char(
      v_occurred_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  )::text;

  v_entry_hash := encode(
    digest(
      convert_to(coalesce(v_previous_hash, '') || '|' || v_canonical, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  insert into public.audit_logs (
    request_id,
    actor_user_id,
    actor_email,
    actor_role,
    actor_ip,
    action,
    target_type,
    target_id,
    result,
    metadata,
    previous_hash,
    entry_hash,
    occurred_at
  ) values (
    p_request_id,
    p_actor_user_id,
    p_actor_email,
    p_actor_role,
    p_actor_ip,
    p_action,
    p_target_type,
    p_target_id,
    p_result,
    p_metadata,
    v_previous_hash,
    v_entry_hash,
    v_occurred_at
  )
  returning id into v_log_id;

  update public.audit_log_chain_state
    set last_log_id = v_log_id,
        last_entry_hash = v_entry_hash,
        updated_at = v_occurred_at
    where singleton = true;

  return v_log_id;
end;
$$;

create or replace function public.transition_operation_job(
  p_job_id uuid,
  p_expected_status text,
  p_new_status text,
  p_actor_type text,
  p_actor_user_id uuid,
  p_request_id uuid,
  p_details jsonb default '{}'::jsonb,
  p_lease_owner text default null,
  p_lease_seconds integer default null
)
returns table (
  job_id uuid,
  job_status text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.operation_jobs%rowtype;
  v_event_type text;
  v_actor public.console_users%rowtype;
  v_error_code text;
  v_now timestamptz := clock_timestamp();
begin
  if p_job_id is null
    or p_expected_status is null
    or p_new_status is null
    or p_actor_type is null
    or p_request_id is null then
    raise exception 'operation_transition_required_field_missing'
      using errcode = '22023';
  end if;

  if p_details is null
    or jsonb_typeof(p_details) <> 'object'
    or octet_length(p_details::text) > 8192
    or public.jsonb_contains_sensitive_key(p_details) then
    raise exception 'operation_transition_details_invalid'
      using errcode = '22023';
  end if;

  if p_actor_type not in ('console_user', 'agent', 'system') then
    raise exception 'operation_transition_actor_invalid'
      using errcode = '22023';
  end if;

  if p_actor_type = 'console_user' then
    select *
      into v_actor
      from public.console_users
      where id = p_actor_user_id
        and is_active = true;
    if not found then
      raise exception 'operation_transition_actor_invalid'
        using errcode = '42501';
    end if;
  elsif p_actor_user_id is not null then
    raise exception 'operation_transition_actor_user_not_allowed'
      using errcode = '22023';
  end if;

  select *
    into v_job
    from public.operation_jobs
    where id = p_job_id
    for update;

  if not found then
    raise exception 'operation_job_not_found'
      using errcode = 'P0002';
  end if;

  if v_job.status <> p_expected_status then
    raise exception 'operation_status_conflict'
      using errcode = '40001';
  end if;

  if not (
    (p_expected_status = 'queued' and p_new_status in ('leased', 'cancelled', 'expired'))
    or (p_expected_status = 'leased' and p_new_status in ('running', 'queued', 'failed', 'expired'))
    or (p_expected_status = 'running' and p_new_status in ('succeeded', 'failed', 'expired'))
  ) then
    raise exception 'operation_transition_not_allowed'
      using errcode = '22023';
  end if;

  if p_expected_status = 'queued' and p_new_status = 'leased' then
    if p_actor_type <> 'agent'
      or p_lease_owner is null
      or char_length(p_lease_owner) not between 1 and 120
      or p_lease_owner !~ '^[A-Za-z0-9._:-]+$'
      or p_lease_seconds is null
      or p_lease_seconds not between 15 and 300 then
      raise exception 'operation_lease_invalid'
        using errcode = '22023';
    end if;
  elsif p_expected_status = 'queued' and p_new_status = 'cancelled' then
    if p_actor_type not in ('console_user', 'system') then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
    if p_actor_type = 'console_user'
      and v_actor.id <> v_job.requested_by
      and v_actor.role not in ('administrator', 'owner') then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
  elsif p_expected_status = 'queued' and p_new_status = 'expired' then
    if p_actor_type <> 'system' then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
  elsif p_expected_status = 'leased' and p_new_status = 'running' then
    if p_actor_type <> 'agent' then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
  elsif p_expected_status = 'leased' and p_new_status in ('queued', 'failed') then
    if p_actor_type = 'system' then
      if v_job.lease_expires_at is null or v_job.lease_expires_at > v_now then
        raise exception 'operation_lease_not_expired'
          using errcode = '42501';
      end if;
    elsif p_actor_type <> 'agent' then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
  elsif p_expected_status = 'leased' and p_new_status = 'expired' then
    if p_actor_type <> 'system' then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
    if v_job.lease_expires_at is null or v_job.lease_expires_at > v_now then
      raise exception 'operation_lease_not_expired'
        using errcode = '42501';
    end if;
  elsif p_expected_status = 'running' and p_new_status in ('succeeded', 'failed') then
    if p_actor_type <> 'agent' then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
  elsif p_expected_status = 'running' and p_new_status = 'expired' then
    if p_actor_type <> 'system' then
      raise exception 'operation_transition_actor_denied'
        using errcode = '42501';
    end if;
    if v_job.lease_expires_at is null or v_job.lease_expires_at > v_now then
      raise exception 'operation_lease_not_expired'
        using errcode = '42501';
    end if;
  end if;

  if p_actor_type = 'agent'
    and p_expected_status in ('leased', 'running')
    and v_job.lease_owner is distinct from p_lease_owner then
    raise exception 'operation_lease_owner_mismatch'
      using errcode = '42501';
  end if;

  case p_new_status
    when 'queued' then v_event_type := 'requeued';
    when 'leased' then v_event_type := 'leased';
    when 'running' then v_event_type := 'started';
    when 'succeeded' then v_event_type := 'succeeded';
    when 'failed' then v_event_type := 'failed';
    when 'cancelled' then v_event_type := 'cancelled';
    when 'expired' then v_event_type := 'expired';
    else raise exception 'operation_transition_not_allowed' using errcode = '22023';
  end case;

  v_error_code := nullif(p_details ->> 'errorCode', '');
  if v_error_code is not null
    and (
      char_length(v_error_code) not between 1 and 120
      or v_error_code !~ '^[a-z0-9._:-]+$'
    ) then
    raise exception 'operation_error_code_invalid'
      using errcode = '22023';
  end if;

  update public.operation_jobs
    set status = p_new_status,
        updated_at = v_now,
        lease_owner = case
          when p_new_status = 'leased' then p_lease_owner
          when p_new_status = 'queued' then null
          else lease_owner
        end,
        leased_at = case
          when p_new_status = 'leased' then v_now
          when p_new_status = 'queued' then null
          else leased_at
        end,
        lease_expires_at = case
          when p_new_status = 'leased'
            then v_now + make_interval(secs => p_lease_seconds)
          when p_new_status = 'queued' then null
          else lease_expires_at
        end,
        started_at = case
          when p_new_status = 'running' then v_now
          else started_at
        end,
        finished_at = case
          when p_new_status in ('succeeded', 'failed', 'cancelled', 'expired')
            then v_now
          else finished_at
        end,
        error_code = case
          when p_new_status = 'failed' then coalesce(v_error_code, 'operation_failed')
          when p_new_status = 'expired' then coalesce(v_error_code, 'operation_lease_expired')
          else error_code
        end,
        result_summary = case
          when p_new_status in ('succeeded', 'failed', 'expired') then p_details
          else result_summary
        end
    where id = p_job_id
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
    v_event_type,
    p_expected_status,
    p_new_status,
    p_actor_type,
    p_actor_user_id,
    p_details
  );

  perform public.append_audit_log(
    p_request_id,
    case when p_actor_type = 'console_user' then v_actor.id else null end,
    case when p_actor_type = 'console_user' then v_actor.email else null end,
    case when p_actor_type = 'console_user' then v_actor.role else null end,
    null,
    'OPERATION_STATUS_CHANGED',
    'operation_job',
    v_job.id::text,
    case when p_new_status in ('failed', 'expired') then 'error' else 'success' end,
    jsonb_build_object(
      'operationType', v_job.operation_type,
      'previousStatus', p_expected_status,
      'newStatus', p_new_status,
      'actorType', p_actor_type
    )
  );

  return query select v_job.id, v_job.status;
end;
$$;

create or replace function public.renew_operation_job_lease(
  p_job_id uuid,
  p_lease_owner text,
  p_request_id uuid,
  p_lease_seconds integer
)
returns table (
  job_id uuid,
  job_status text,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job public.operation_jobs%rowtype;
  v_new_expiry timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_job_id is null
    or p_request_id is null
    or p_lease_owner is null
    or char_length(p_lease_owner) not between 1 and 120
    or p_lease_owner !~ '^[A-Za-z0-9._:-]+$'
    or p_lease_seconds is null
    or p_lease_seconds not between 15 and 300 then
    raise exception 'operation_lease_renewal_invalid'
      using errcode = '22023';
  end if;

  select *
    into v_job
    from public.operation_jobs
    where id = p_job_id
    for update;

  if not found then
    raise exception 'operation_job_not_found' using errcode = 'P0002';
  end if;

  if v_job.status not in ('leased', 'running') then
    raise exception 'operation_lease_renewal_status_invalid'
      using errcode = '40001';
  end if;

  if v_job.lease_owner is distinct from p_lease_owner then
    raise exception 'operation_lease_owner_mismatch'
      using errcode = '42501';
  end if;

  if v_job.lease_expires_at is null or v_job.lease_expires_at <= v_now then
    raise exception 'operation_lease_expired'
      using errcode = '42501';
  end if;

  v_new_expiry := v_now + make_interval(secs => p_lease_seconds);

  update public.operation_jobs
    set lease_expires_at = v_new_expiry,
        updated_at = v_now
    where id = v_job.id;

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
    'lease_renewed',
    v_job.status,
    v_job.status,
    'agent',
    null,
    jsonb_build_object('leaseExpiresAt', v_new_expiry)
  );

  perform public.append_audit_log(
    p_request_id,
    null,
    null,
    null,
    null,
    'OPERATION_LEASE_RENEWED',
    'operation_job',
    v_job.id::text,
    'success',
    jsonb_build_object(
      'operationType', v_job.operation_type,
      'status', v_job.status,
      'leaseExpiresAt', v_new_expiry
    )
  );

  return query select v_job.id, v_job.status, v_new_expiry;
end;
$$;

create or replace function public.expire_stale_operation_jobs(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job record;
  v_expired integer := 0;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'operation_expire_limit_invalid' using errcode = '22023';
  end if;

  for v_job in
    select jobs.id, jobs.status
    from public.operation_jobs as jobs
    where jobs.status in ('leased', 'running')
      and jobs.lease_expires_at is not null
      and jobs.lease_expires_at <= clock_timestamp()
    order by jobs.lease_expires_at, jobs.id
    for update skip locked
    limit p_limit
  loop
    perform *
    from public.transition_operation_job(
      v_job.id,
      v_job.status,
      'expired',
      'system',
      null,
      gen_random_uuid(),
      jsonb_build_object(
        'errorCode', 'operation_lease_expired',
        'reason', 'lease_expired'
      ),
      null,
      null
    );
    v_expired := v_expired + 1;
  end loop;

  return v_expired;
end;
$$;

revoke all on function public.append_audit_log(
  uuid, uuid, text, text, inet, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.transition_operation_job(
  uuid, text, text, text, uuid, uuid, jsonb, text, integer
) from public, anon, authenticated;
revoke all on function public.renew_operation_job_lease(
  uuid, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.expire_stale_operation_jobs(integer)
  from public, anon, authenticated;

grant execute on function public.append_audit_log(
  uuid, uuid, text, text, inet, text, text, text, text, jsonb
) to service_role;
grant execute on function public.transition_operation_job(
  uuid, text, text, text, uuid, uuid, jsonb, text, integer
) to service_role;
grant execute on function public.renew_operation_job_lease(
  uuid, text, uuid, integer
) to service_role;
grant execute on function public.expire_stale_operation_jobs(integer)
  to service_role;

comment on function public.renew_operation_job_lease is
  '同じ管理Agentだけがleased/running Jobの有効期限を延長する。';
comment on function public.expire_stale_operation_jobs is
  '期限切れのleased/running JobをSystem Actorとしてexpiredへ遷移するReaper。';
