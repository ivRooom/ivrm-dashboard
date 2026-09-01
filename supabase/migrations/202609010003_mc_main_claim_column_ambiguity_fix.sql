-- Issue #68 Phase B-1 production contract fix.
-- Qualify operation_jobs columns because RETURNS TABLE output parameters are
-- visible as PL/pgSQL variables and otherwise collide with column names such
-- as operation_type and lease_expires_at.

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
  select j.* into v_job
    from public.operation_jobs as j
   where j.host_id=v_host.id
     and j.lease_owner=p_lease_owner
     and j.status in ('leased','running')
     and j.lease_expires_at>clock_timestamp()
     and j.operation_type in ('start_backend','restart_backend','stop_backend')
   order by j.created_at,j.id
   for update of j skip locked
   limit 1;
  if found then
    perform * from public.renew_operation_job_lease(
      v_job.id,p_lease_owner,p_request_id,p_lease_seconds
    );
    return query
      select j.id,j.operation_type,j.status,j.lease_expires_at
        from public.operation_jobs as j
       where j.id=v_job.id;
    return;
  end if;

  select j.* into v_job
    from public.operation_jobs as j
   where j.host_id=v_host.id
     and j.status='queued'
     and j.operation_type in ('start_backend','restart_backend','stop_backend')
   order by j.created_at,j.id
   for update of j skip locked
   limit 1;
  if not found then return; end if;

  perform public.transition_operation_job(
    v_job.id,'queued','leased','agent',null,p_request_id,
    jsonb_build_object('phase','claimed'),p_lease_owner,p_lease_seconds
  );

  return query
    select j.id,j.operation_type,j.status,j.lease_expires_at
      from public.operation_jobs as j
     where j.id=v_job.id;
end;
$$;

revoke all on function public.claim_mc_main_operation_job(text,text,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.claim_mc_main_operation_job(text,text,uuid,integer)
  to service_role;
