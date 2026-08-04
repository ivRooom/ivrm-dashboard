create table public.operation_jobs (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts(id) on delete restrict,
  operation_type text not null,
  lock_scope text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued',
  requested_by uuid not null references public.console_users(id) on delete restrict,
  requested_email text not null,
  requested_role text not null,
  idempotency_key_hash text not null,
  confirmation_verified boolean not null default false,
  request_id uuid not null,
  lease_owner text,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  result_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operation_jobs_type_check check (
    operation_type in (
      'save_world',
      'restart_backend',
      'restart_proxy',
      'start_backend',
      'stop_backend',
      'maintenance_start',
      'maintenance_end',
      'create_backup',
      'verify_backup'
    )
  ),
  constraint operation_jobs_lock_scope_check check (
    char_length(lock_scope) between 1 and 120
    and lock_scope ~ '^[a-z0-9:_-]+$'
  ),
  constraint operation_jobs_payload_check check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 8192
  ),
  constraint operation_jobs_status_check check (
    status in (
      'queued',
      'leased',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired'
    )
  ),
  constraint operation_jobs_requested_email_check check (
    char_length(requested_email) between 3 and 320
    and requested_email = lower(btrim(requested_email))
  ),
  constraint operation_jobs_requested_role_check check (
    requested_role in ('viewer', 'operator', 'administrator', 'owner')
  ),
  constraint operation_jobs_idempotency_hash_check check (
    idempotency_key_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint operation_jobs_lease_owner_check check (
    lease_owner is null
    or (
      char_length(lease_owner) between 1 and 120
      and lease_owner = btrim(lease_owner)
      and lease_owner ~ '^[A-Za-z0-9._:-]+$'
    )
  ),
  constraint operation_jobs_lease_time_check check (
    lease_expires_at is null
    or (leased_at is not null and lease_expires_at > leased_at)
  ),
  constraint operation_jobs_error_code_check check (
    error_code is null
    or (
      char_length(error_code) between 1 and 120
      and error_code ~ '^[a-z0-9._:-]+$'
    )
  ),
  constraint operation_jobs_result_summary_check check (
    result_summary is null
    or (
      jsonb_typeof(result_summary) = 'object'
      and octet_length(result_summary::text) <= 8192
    )
  ),
  constraint operation_jobs_finished_status_check check (
    finished_at is null
    or status in ('succeeded', 'failed', 'cancelled', 'expired')
  )
);

create unique index operation_jobs_idempotency_key
  on public.operation_jobs (
    requested_by,
    host_id,
    operation_type,
    idempotency_key_hash
  );

create unique index operation_jobs_active_lock_scope_key
  on public.operation_jobs (host_id, lock_scope)
  where status in ('queued', 'leased', 'running');

create index operation_jobs_status_created_idx
  on public.operation_jobs (status, created_at);

create index operation_jobs_actor_created_idx
  on public.operation_jobs (requested_by, created_at desc);

create table public.operation_events (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.operation_jobs(id) on delete restrict,
  event_type text not null,
  previous_status text,
  new_status text not null,
  actor_type text not null,
  actor_user_id uuid references public.console_users(id) on delete restrict,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint operation_events_type_check check (
    event_type in (
      'requested',
      'leased',
      'started',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
      'requeued'
    )
  ),
  constraint operation_events_previous_status_check check (
    previous_status is null
    or previous_status in (
      'queued',
      'leased',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired'
    )
  ),
  constraint operation_events_new_status_check check (
    new_status in (
      'queued',
      'leased',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired'
    )
  ),
  constraint operation_events_actor_type_check check (
    actor_type in ('console_user', 'agent', 'system')
  ),
  constraint operation_events_details_check check (
    jsonb_typeof(details) = 'object'
    and octet_length(details::text) <= 8192
  )
);

create index operation_events_job_created_idx
  on public.operation_events (job_id, created_at);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  request_id uuid not null,
  actor_user_id uuid references public.console_users(id) on delete restrict,
  actor_email text,
  actor_role text,
  actor_ip inet,
  action text not null,
  target_type text not null,
  target_id text,
  result text not null,
  metadata jsonb not null default '{}'::jsonb,
  previous_hash text,
  entry_hash text not null unique,
  occurred_at timestamptz not null,
  constraint audit_logs_actor_email_check check (
    actor_email is null
    or (
      char_length(actor_email) between 3 and 320
      and actor_email = lower(btrim(actor_email))
    )
  ),
  constraint audit_logs_actor_role_check check (
    actor_role is null
    or actor_role in ('viewer', 'operator', 'administrator', 'owner')
  ),
  constraint audit_logs_action_check check (
    char_length(action) between 1 and 120
    and action ~ '^[A-Z0-9_]+$'
  ),
  constraint audit_logs_target_type_check check (
    char_length(target_type) between 1 and 120
    and target_type ~ '^[a-z0-9:_-]+$'
  ),
  constraint audit_logs_target_id_check check (
    target_id is null
    or char_length(target_id) between 1 and 255
  ),
  constraint audit_logs_result_check check (
    result in ('success', 'denied', 'conflict', 'error')
  ),
  constraint audit_logs_metadata_check check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 8192
  ),
  constraint audit_logs_previous_hash_check check (
    previous_hash is null
    or previous_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_logs_entry_hash_check check (
    entry_hash ~ '^[0-9a-f]{64}$'
  )
);

create index audit_logs_occurred_idx
  on public.audit_logs (occurred_at desc);

create index audit_logs_request_idx
  on public.audit_logs (request_id, occurred_at);

create index audit_logs_actor_idx
  on public.audit_logs (actor_user_id, occurred_at desc);

create table public.audit_log_chain_state (
  singleton boolean primary key default true check (singleton),
  last_log_id bigint,
  last_entry_hash text,
  updated_at timestamptz not null default now(),
  constraint audit_log_chain_hash_check check (
    last_entry_hash is null
    or last_entry_hash ~ '^[0-9a-f]{64}$'
  )
);

insert into public.audit_log_chain_state (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.operation_jobs enable row level security;
alter table public.operation_jobs force row level security;
alter table public.operation_events enable row level security;
alter table public.operation_events force row level security;
alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;
alter table public.audit_log_chain_state enable row level security;
alter table public.audit_log_chain_state force row level security;

create or replace function public.prevent_immutable_log_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'immutable_log_mutation_forbidden'
    using errcode = '55000';
end;
$$;

create trigger operation_events_immutable
before update or delete or truncate on public.operation_events
for each statement execute function public.prevent_immutable_log_mutation();

create trigger audit_logs_immutable
before update or delete or truncate on public.audit_logs
for each statement execute function public.prevent_immutable_log_mutation();

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

  if p_result not in ('success', 'denied', 'conflict', 'error') then
    raise exception 'audit_result_invalid' using errcode = '22023';
  end if;

  if p_metadata is null
    or jsonb_typeof(p_metadata) <> 'object'
    or octet_length(p_metadata::text) > 8192 then
    raise exception 'audit_metadata_invalid' using errcode = '22023';
  end if;

  if p_metadata ?| array[
    'secret',
    'password',
    'token',
    'command',
    'rcon_password',
    'forwarding_secret'
  ] then
    raise exception 'audit_sensitive_metadata_forbidden' using errcode = '22023';
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
    raise exception 'operation_role_denied'
      using errcode = '42501';
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
    raise exception 'operation_confirmation_required'
      using errcode = '42501';
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
begin
  if p_job_id is null or p_request_id is null then
    raise exception 'operation_transition_required_field_missing'
      using errcode = '22023';
  end if;

  if p_details is null
    or jsonb_typeof(p_details) <> 'object'
    or octet_length(p_details::text) > 8192
    or p_details ?| array[
      'secret',
      'password',
      'token',
      'command',
      'rcon_password',
      'forwarding_secret'
    ] then
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
    or (p_expected_status = 'running' and p_new_status in ('succeeded', 'failed'))
  ) then
    raise exception 'operation_transition_not_allowed'
      using errcode = '22023';
  end if;

  if p_new_status = 'leased' then
    if p_actor_type <> 'agent'
      or p_lease_owner is null
      or char_length(p_lease_owner) not between 1 and 120
      or p_lease_owner !~ '^[A-Za-z0-9._:-]+$'
      or p_lease_seconds is null
      or p_lease_seconds not between 15 and 300 then
      raise exception 'operation_lease_invalid'
        using errcode = '22023';
    end if;
  elsif p_expected_status = 'leased'
    and p_actor_type = 'agent'
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
        updated_at = clock_timestamp(),
        lease_owner = case
          when p_new_status = 'leased' then p_lease_owner
          when p_new_status = 'queued' then null
          else lease_owner
        end,
        leased_at = case
          when p_new_status = 'leased' then clock_timestamp()
          when p_new_status = 'queued' then null
          else leased_at
        end,
        lease_expires_at = case
          when p_new_status = 'leased'
            then clock_timestamp() + make_interval(secs => p_lease_seconds)
          when p_new_status = 'queued' then null
          else lease_expires_at
        end,
        started_at = case
          when p_new_status = 'running' then clock_timestamp()
          else started_at
        end,
        finished_at = case
          when p_new_status in ('succeeded', 'failed', 'cancelled', 'expired')
            then clock_timestamp()
          else finished_at
        end,
        error_code = case
          when p_new_status = 'failed' then coalesce(v_error_code, 'operation_failed')
          else error_code
        end,
        result_summary = case
          when p_new_status in ('succeeded', 'failed') then p_details
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
    case when p_new_status = 'failed' then 'error' else 'success' end,
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

revoke all on table public.operation_jobs from public, anon, authenticated;
revoke all on table public.operation_events from public, anon, authenticated;
revoke all on table public.audit_logs from public, anon, authenticated;
revoke all on table public.audit_log_chain_state from public, anon, authenticated;

revoke all on table public.operation_jobs from service_role;
revoke all on table public.operation_events from service_role;
revoke all on table public.audit_logs from service_role;
revoke all on table public.audit_log_chain_state from service_role;

grant select on table public.operation_jobs to service_role;
grant select on table public.operation_events to service_role;
grant select on table public.audit_logs to service_role;

revoke all on function public.prevent_immutable_log_mutation() from public, anon, authenticated, service_role;
revoke all on function public.append_audit_log(uuid, uuid, text, text, inet, text, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.enqueue_operation_job(uuid, text, jsonb, uuid, text, text, boolean, uuid, inet)
  from public, anon, authenticated;
revoke all on function public.transition_operation_job(uuid, text, text, text, uuid, uuid, jsonb, text, integer)
  from public, anon, authenticated;

grant execute on function public.append_audit_log(uuid, uuid, text, text, inet, text, text, text, text, jsonb)
  to service_role;
grant execute on function public.enqueue_operation_job(uuid, text, jsonb, uuid, text, text, boolean, uuid, inet)
  to service_role;
grant execute on function public.transition_operation_job(uuid, text, text, text, uuid, uuid, jsonb, text, integer)
  to service_role;

comment on table public.operation_jobs is
  '許可リスト型のMinecraft管理操作ジョブ。実行コマンドやSecretは保存しない。';
comment on table public.operation_events is
  '操作ジョブの追記専用状態遷移履歴。';
comment on table public.audit_logs is
  'ハッシュチェーン付きの追記専用Webコンソール監査ログ。';
comment on function public.enqueue_operation_job is
  'RBAC・確認・冪等性・排他を検証して操作ジョブを作成する。';
comment on function public.transition_operation_job is
  '許可済みの状態遷移だけを適用し、イベントと監査ログを追記する。';
