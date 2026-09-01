-- Issue #68 Phase B-1: fixed mc-main Agent transition bridge.
-- Only the three lifecycle actions can cross this wrapper.

create or replace function public.transition_mc_main_operation_job(
  p_server_id text,
  p_job_id uuid,
  p_operation_type text,
  p_expected_status text,
  p_new_status text,
  p_lease_owner text,
  p_request_id uuid,
  p_details jsonb
) returns table(job_id uuid,job_status text)
language plpgsql
security definer
set search_path=public,extensions
as $$
declare
  v_host public.hosts%rowtype;
  v_job public.operation_jobs%rowtype;
  v_error_code text;
  v_detail_count integer;
begin
  if p_server_id is null or p_server_id<>'oci-minecraft-01'
     or p_job_id is null or p_request_id is null
     or p_operation_type not in ('start_backend','restart_backend','stop_backend')
     or p_lease_owner is null or char_length(p_lease_owner) not between 1 and 120
     or p_lease_owner !~ '^[A-Za-z0-9._:-]+$' then
    raise exception 'operation_transition_invalid' using errcode='22023';
  end if;

  select * into v_host
    from public.hosts
   where server_id=p_server_id and enabled=true;
  if not found then
    raise exception 'operation_agent_unknown' using errcode='42501';
  end if;

  select * into v_job
    from public.operation_jobs
   where id=p_job_id
   for update;
  if not found then
    raise exception 'operation_job_not_found' using errcode='P0002';
  end if;
  if v_job.host_id<>v_host.id or v_job.operation_type<>p_operation_type then
    raise exception 'operation_target_or_action_mismatch' using errcode='42501';
  end if;

  if p_details is null or jsonb_typeof(p_details)<>'object'
     or octet_length(p_details::text)>2048
     or public.jsonb_contains_sensitive_key(p_details) then
    raise exception 'operation_transition_details_invalid' using errcode='22023';
  end if;
  select count(*) into v_detail_count from jsonb_object_keys(p_details);

  if p_expected_status='leased' and p_new_status='running' then
    if v_detail_count<>1 or p_details->>'phase'<>'executing' then
      raise exception 'operation_transition_details_invalid' using errcode='22023';
    end if;
  elsif p_expected_status='running' and p_new_status='succeeded' then
    if v_detail_count<>1 then
      raise exception 'operation_transition_details_invalid' using errcode='22023';
    end if;
    if p_operation_type='stop_backend' then
      if p_details->>'phase'<>'stopped' then
        raise exception 'operation_transition_details_invalid' using errcode='22023';
      end if;
    elsif p_details->>'phase'<>'health_gate_passed' then
      raise exception 'operation_transition_details_invalid' using errcode='22023';
    end if;
  elsif p_expected_status='running' and p_new_status='failed' then
    v_error_code:=p_details->>'errorCode';
    if v_detail_count<>2 or p_details->>'phase'<>'execution_failed'
       or v_error_code is null or char_length(v_error_code) not between 1 and 120
       or v_error_code !~ '^[a-z0-9._:-]+$' then
      raise exception 'operation_transition_details_invalid' using errcode='22023';
    end if;
  else
    raise exception 'operation_transition_not_allowed' using errcode='22023';
  end if;

  return query
    select result.job_id,result.job_status
      from public.transition_operation_job(
        p_job_id,
        p_expected_status,
        p_new_status,
        'agent',
        null,
        p_request_id,
        p_details,
        p_lease_owner,
        null
      ) as result;
end;
$$;

revoke all on function public.transition_mc_main_operation_job(text,uuid,text,text,text,text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.transition_mc_main_operation_job(text,uuid,text,text,text,text,uuid,jsonb)
  to service_role;
