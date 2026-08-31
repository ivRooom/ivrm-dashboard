-- Issue #68 Phase B-1: Discord Console -> operation queue -> mc-main Agent lease bridge.
-- Execution remains opt-in on OCI. This migration does not execute Minecraft lifecycle actions.

alter table public.operation_jobs alter column requested_by drop not null;
alter table public.operation_jobs alter column requested_email drop not null;
alter table public.operation_jobs add column requested_actor_type text not null default 'console_user';
alter table public.operation_jobs add column requested_discord_user_id text;

alter table public.operation_jobs add constraint operation_jobs_requested_actor_type_check
  check (requested_actor_type in ('console_user','discord'));
alter table public.operation_jobs add constraint operation_jobs_requested_discord_user_id_check
  check (requested_discord_user_id is null or requested_discord_user_id ~ '^[0-9]{17,20}$');
alter table public.operation_jobs add constraint operation_jobs_requested_actor_identity_check
  check (
    (requested_actor_type='console_user' and requested_by is not null and requested_email is not null and requested_discord_user_id is null)
    or
    (requested_actor_type='discord' and requested_by is null and requested_email is null and requested_discord_user_id is not null)
  );

create unique index operation_jobs_discord_idempotency_key
  on public.operation_jobs(requested_discord_user_id,host_id,operation_type,idempotency_key_hash)
  where requested_actor_type='discord';
create index operation_jobs_discord_actor_created_idx
  on public.operation_jobs(requested_discord_user_id,created_at desc)
  where requested_actor_type='discord';

create table public.operation_agent_requests (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  request_kind text not null check (request_kind in ('claim','transition')),
  nonce text not null check (nonce ~ '^[a-f0-9]{32}$'),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  unique(host_id,nonce)
);

create index operation_agent_requests_received_idx
  on public.operation_agent_requests(received_at);

alter table public.operation_agent_requests enable row level security;
alter table public.operation_agent_requests force row level security;
revoke all on table public.operation_agent_requests from public, anon, authenticated, service_role;
revoke all on sequence public.operation_agent_requests_id_seq from public, anon, authenticated, service_role;

create or replace function public.accept_operation_agent_request(
  p_server_id text,
  p_request_kind text,
  p_nonce text,
  p_body_sha256 text
) returns boolean
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_host public.hosts%rowtype;
begin
  if p_server_id is null or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
     or p_request_kind not in ('claim','transition')
     or p_nonce is null or p_nonce !~ '^[a-f0-9]{32}$'
     or p_body_sha256 is null or p_body_sha256 !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  select * into v_host
    from public.hosts
   where server_id=p_server_id and enabled=true;
  if not found then return false; end if;

  delete from public.operation_agent_requests
   where host_id=v_host.id
     and received_at < clock_timestamp()-interval '24 hours';

  begin
    insert into public.operation_agent_requests(host_id,request_kind,nonce,body_sha256)
    values(v_host.id,p_request_kind,p_nonce,p_body_sha256);
  exception when unique_violation then
    return false;
  end;
  return true;
end;
$$;

revoke all on function public.accept_operation_agent_request(text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.accept_operation_agent_request(text,text,text,text)
  to service_role;

create or replace function public.enqueue_discord_operation_job(
  p_discord_session_id uuid,
  p_server_id text,
  p_operation_type text,
  p_payload jsonb,
  p_idempotency_key_hash text,
  p_confirmation_text text,
  p_request_id uuid
) returns table(job_id uuid,job_status text,outcome text,error_code text)
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_session public.discord_console_sessions%rowtype;
  v_host public.hosts%rowtype;
  v_job public.operation_jobs%rowtype;
  v_existing public.operation_jobs%rowtype;
  v_conflict public.operation_jobs%rowtype;
  v_required_role text;
  v_required_rank integer;
  v_actor_rank integer;
  v_confirmation text;
  v_lock_scope text:='minecraft:exclusive';
  v_confirmation_verified boolean:=false;
begin
  if p_discord_session_id is null or p_request_id is null then
    raise exception 'operation_request_required_field_missing' using errcode='22023';
  end if;

  select * into v_session
    from public.discord_console_sessions
   where id=p_discord_session_id
     and revoked_at is null
     and expires_at>clock_timestamp();
  if not found then
    return query select null::uuid,null::text,'denied'::text,'session_invalid'::text;
    return;
  end if;

  if p_server_id is null or p_server_id<>'oci-minecraft-01' then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'reason','target_not_allowed')
    );
    return query select null::uuid,null::text,'denied'::text,'target_not_allowed'::text;
    return;
  end if;

  select * into v_host
    from public.hosts
   where server_id=p_server_id and enabled=true;
  if not found then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'reason','target_unavailable')
    );
    return query select null::uuid,null::text,'denied'::text,'target_unavailable'::text;
    return;
  end if;

  case p_operation_type
    when 'start_backend' then
      v_required_role:='operator'; v_required_rank:=1; v_confirmation:=null;
    when 'restart_backend' then
      v_required_role:='operator'; v_required_rank:=1; v_confirmation:='RESTART';
    when 'stop_backend' then
      v_required_role:='administrator'; v_required_rank:=2; v_confirmation:='STOP';
    else
      perform public.append_audit_log(
        p_request_id,null,null,v_session.console_role,null,
        'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
        jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'reason','action_not_allowed')
      );
      return query select null::uuid,null::text,'denied'::text,'action_not_allowed'::text;
      return;
  end case;

  if p_payload is null or jsonb_typeof(p_payload)<>'object' or p_payload<>'{}'::jsonb then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,'reason','payload_not_allowed')
    );
    return query select null::uuid,null::text,'denied'::text,'payload_not_allowed'::text;
    return;
  end if;

  if p_idempotency_key_hash is null or p_idempotency_key_hash !~ '^[a-f0-9]{64}$' then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,'reason','idempotency_invalid')
    );
    return query select null::uuid,null::text,'denied'::text,'idempotency_invalid'::text;
    return;
  end if;

  v_actor_rank:=case v_session.console_role
    when 'viewer' then 0
    when 'operator' then 1
    when 'administrator' then 2
    when 'owner' then 3
    else -1
  end;
  if v_actor_rank<v_required_rank then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object(
        'actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,
        'reason','insufficient_role','requiredRole',v_required_role
      )
    );
    return query select null::uuid,null::text,'denied'::text,'insufficient_role'::text;
    return;
  end if;

  if v_confirmation is null then
    if p_confirmation_text is not null and p_confirmation_text<>'' then
      perform public.append_audit_log(
        p_request_id,null,null,v_session.console_role,null,
        'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
        jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,'reason','confirmation_not_allowed')
      );
      return query select null::uuid,null::text,'denied'::text,'confirmation_not_allowed'::text;
      return;
    end if;
    v_confirmation_verified:=true;
  elsif p_confirmation_text is distinct from v_confirmation then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,'reason','confirmation_invalid')
    );
    return query select null::uuid,null::text,'denied'::text,'confirmation_invalid'::text;
    return;
  else
    v_confirmation_verified:=true;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_host.id::text||':'||v_lock_scope,0));

  select * into v_existing
    from public.operation_jobs
   where requested_actor_type='discord'
     and requested_discord_user_id=v_session.discord_user_id
     and host_id=v_host.id
     and operation_type=p_operation_type
     and idempotency_key_hash=p_idempotency_key_hash
   limit 1;
  if found then
    return query select v_existing.id,v_existing.status,'existing'::text,null::text;
    return;
  end if;

  select * into v_conflict
    from public.operation_jobs
   where host_id=v_host.id
     and lock_scope=v_lock_scope
     and status in ('queued','leased','running')
   order by created_at,id
   limit 1;
  if found then
    perform public.append_audit_log(
      p_request_id,null,null,v_session.console_role,null,
      'OPERATION_REQUEST_DENIED','operation_job',null,'denied',
      jsonb_build_object('actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,'reason','exclusive_conflict')
    );
    return query select v_conflict.id,v_conflict.status,'conflict'::text,'operation_conflict'::text;
    return;
  end if;

  insert into public.operation_jobs(
    host_id,operation_type,lock_scope,payload,status,
    requested_by,requested_email,requested_role,requested_actor_type,requested_discord_user_id,
    idempotency_key_hash,confirmation_verified,request_id
  ) values(
    v_host.id,p_operation_type,v_lock_scope,'{}'::jsonb,'queued',
    null,null,v_session.console_role,'discord',v_session.discord_user_id,
    p_idempotency_key_hash,v_confirmation_verified,p_request_id
  ) returning * into v_job;

  insert into public.operation_events(
    job_id,event_type,previous_status,new_status,actor_type,actor_user_id,details
  ) values(
    v_job.id,'requested',null,'queued','console_user',null,
    jsonb_build_object('actorSource','discord')
  );

  perform public.append_audit_log(
    p_request_id,null,null,v_session.console_role,null,
    'OPERATION_REQUESTED','operation_job',v_job.id::text,'success',
    jsonb_build_object(
      'actorType','discord','discordUserId',v_session.discord_user_id,'operationType',p_operation_type,
      'lockScope',v_lock_scope,'confirmationVerified',v_confirmation_verified
    )
  );

  return query select v_job.id,v_job.status,'created'::text,null::text;
end;
$$;

revoke all on function public.enqueue_discord_operation_job(uuid,text,text,jsonb,text,text,uuid)
  from public,anon,authenticated;
grant execute on function public.enqueue_discord_operation_job(uuid,text,text,jsonb,text,text,uuid)
  to service_role;

create or replace function public.claim_mc_main_operation_job(
  p_server_id text,
  p_lease_owner text,
  p_request_id uuid,
  p_lease_seconds integer default 300
) returns table(job_id uuid,operation_type text,job_status text,lease_expires_at timestamptz)
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_host public.hosts%rowtype;
  v_job public.operation_jobs%rowtype;
begin
  if p_server_id is null or p_server_id<>'oci-minecraft-01' or p_request_id is null
     or p_lease_owner is null or char_length(p_lease_owner) not between 1 and 120
     or p_lease_owner !~ '^[A-Za-z0-9._:-]+$'
     or p_lease_seconds is null or p_lease_seconds not between 15 and 300 then
    raise exception 'operation_claim_invalid' using errcode='22023';
  end if;

  select * into v_host
    from public.hosts
   where server_id=p_server_id and enabled=true;
  if not found then
    raise exception 'operation_agent_unknown' using errcode='42501';
  end if;

  perform public.expire_stale_operation_jobs(100);

  -- Worker restart recovery: resume the active Job already owned by this exact Agent
  -- before claiming new work. Renewing here gives the recovered worker a fresh bounded
  -- lease without allowing another owner to take over the operation.
  select * into v_job
    from public.operation_jobs
   where host_id=v_host.id
     and lease_owner=p_lease_owner
     and status in ('leased','running')
     and lease_expires_at>clock_timestamp()
     and operation_type in ('start_backend','restart_backend','stop_backend')
   order by created_at,id
   for update skip locked
   limit 1;
  if found then
    perform * from public.renew_operation_job_lease(
      v_job.id,p_lease_owner,p_request_id,p_lease_seconds
    );
    return query
      select j.id,j.operation_type,j.status,j.lease_expires_at
        from public.operation_jobs j
       where j.id=v_job.id;
    return;
  end if;

  select * into v_job
    from public.operation_jobs
   where host_id=v_host.id
     and status='queued'
     and operation_type in ('start_backend','restart_backend','stop_backend')
   order by created_at,id
   for update skip locked
   limit 1;
  if not found then return; end if;

  perform public.transition_operation_job(
    v_job.id,'queued','leased','agent',null,p_request_id,
    jsonb_build_object('phase','claimed'),p_lease_owner,p_lease_seconds
  );

  return query
    select j.id,j.operation_type,j.status,j.lease_expires_at
      from public.operation_jobs j
     where j.id=v_job.id;
end;
$$;

revoke all on function public.claim_mc_main_operation_job(text,text,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.claim_mc_main_operation_job(text,text,uuid,integer)
  to service_role;
