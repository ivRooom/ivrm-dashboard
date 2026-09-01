-- Issue #68 Phase B-1 DB contract verification.
-- Run only after 202609010001/0002 migrations. The transaction is always rolled back.

begin;

do $$
declare
  v_viewer_session uuid:=gen_random_uuid();
  v_operator_session uuid:=gen_random_uuid();
  v_admin_session uuid:=gen_random_uuid();
  v_result record;
  v_duplicate record;
  v_job_id uuid;
  v_claim record;
  v_recovered record;
  v_bool boolean;
  v_count integer;
  v_status text;
  v_old_expiry timestamptz;
  v_lease_owner text:='oci-minecraft-01:phase-b1-contract';
begin
  insert into public.discord_console_sessions(
    id,session_token_hash,discord_user_id,discord_username,guild_id,matched_role_ids,
    console_role,created_at,expires_at,last_seen_at
  ) values
    (v_viewer_session,md5(random()::text)||md5(random()::text),'99999999999999001','phase-b1-viewer','99999999999999101',array['99999999999999201'],'viewer',clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()),
    (v_operator_session,md5(random()::text)||md5(random()::text),'99999999999999002','phase-b1-operator','99999999999999101',array['99999999999999202'],'operator',clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp()),
    (v_admin_session,md5(random()::text)||md5(random()::text),'99999999999999003','phase-b1-admin','99999999999999101',array['99999999999999203'],'administrator',clock_timestamp(),clock_timestamp()+interval '1 hour',clock_timestamp());

  -- viewer mutation拒否
  select * into v_result from public.enqueue_discord_operation_job(
    v_viewer_session,'oci-minecraft-01','start_backend','{}'::jsonb,repeat('1',64),null,gen_random_uuid()
  );
  if v_result.outcome<>'denied' or v_result.error_code<>'insufficient_role' then
    raise exception 'contract_viewer_start_not_denied';
  end if;

  -- operator start許可
  select * into v_result from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','start_backend','{}'::jsonb,repeat('2',64),null,gen_random_uuid()
  );
  if v_result.outcome<>'created' or v_result.job_status<>'queued' then
    raise exception 'contract_operator_start_not_created';
  end if;
  v_job_id:=v_result.job_id;

  -- duplicate idempotencyは同一Job
  select * into v_duplicate from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','start_backend','{}'::jsonb,repeat('2',64),null,gen_random_uuid()
  );
  if v_duplicate.outcome<>'existing' or v_duplicate.job_id<>v_job_id then
    raise exception 'contract_idempotency_failed';
  end if;

  -- 排他競合
  select * into v_result from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','restart_backend','{}'::jsonb,repeat('3',64),'RESTART',gen_random_uuid()
  );
  if v_result.outcome<>'conflict' or v_result.error_code<>'operation_conflict' then
    raise exception 'contract_exclusive_conflict_failed';
  end if;

  perform * from public.transition_operation_job(
    v_job_id,'queued','cancelled','system',null,gen_random_uuid(),'{}'::jsonb,null,null
  );

  -- operator restartはRESTART必須
  select * into v_result from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','restart_backend','{}'::jsonb,repeat('4',64),null,gen_random_uuid()
  );
  if v_result.outcome<>'denied' or v_result.error_code<>'confirmation_invalid' then
    raise exception 'contract_restart_confirmation_missing';
  end if;
  select * into v_result from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','restart_backend','{}'::jsonb,repeat('5',64),'RESTART',gen_random_uuid()
  );
  if v_result.outcome<>'created' then raise exception 'contract_restart_not_created'; end if;
  perform * from public.transition_operation_job(
    v_result.job_id,'queued','cancelled','system',null,gen_random_uuid(),'{}'::jsonb,null,null
  );

  -- operator stop拒否 / administrator STOP必須
  select * into v_result from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','stop_backend','{}'::jsonb,repeat('6',64),'STOP',gen_random_uuid()
  );
  if v_result.outcome<>'denied' or v_result.error_code<>'insufficient_role' then
    raise exception 'contract_operator_stop_not_denied';
  end if;
  select * into v_result from public.enqueue_discord_operation_job(
    v_admin_session,'oci-minecraft-01','stop_backend','{}'::jsonb,repeat('7',64),'WRONG',gen_random_uuid()
  );
  if v_result.outcome<>'denied' or v_result.error_code<>'confirmation_invalid' then
    raise exception 'contract_admin_stop_confirmation_missing';
  end if;
  select * into v_result from public.enqueue_discord_operation_job(
    v_admin_session,'oci-minecraft-01','stop_backend','{}'::jsonb,repeat('8',64),'STOP',gen_random_uuid()
  );
  if v_result.outcome<>'created' then raise exception 'contract_admin_stop_not_created'; end if;
  v_job_id:=v_result.job_id;

  -- unknown target / action / arbitrary payload拒否
  select * into v_result from public.enqueue_discord_operation_job(
    v_admin_session,'other-host','start_backend','{}'::jsonb,repeat('9',64),null,gen_random_uuid()
  );
  if v_result.error_code<>'target_not_allowed' then raise exception 'contract_unknown_target_not_denied'; end if;
  select * into v_result from public.enqueue_discord_operation_job(
    v_admin_session,'oci-minecraft-01','arbitrary_shell','{}'::jsonb,repeat('a',64),null,gen_random_uuid()
  );
  if v_result.error_code<>'action_not_allowed' then raise exception 'contract_unknown_action_not_denied'; end if;
  select * into v_result from public.enqueue_discord_operation_job(
    v_admin_session,'oci-minecraft-01','start_backend','{"command":"docker restart mc-main"}'::jsonb,repeat('b',64),null,gen_random_uuid()
  );
  if v_result.error_code<>'payload_not_allowed' then raise exception 'contract_arbitrary_payload_not_denied'; end if;

  -- Agent claim + lease owner / state / sensitive details
  select * into v_claim from public.claim_mc_main_operation_job(
    'oci-minecraft-01',v_lease_owner,gen_random_uuid(),300
  );
  if v_claim.job_id<>v_job_id or v_claim.job_status<>'leased' then raise exception 'contract_claim_failed'; end if;

  begin
    perform * from public.transition_mc_main_operation_job(
      'oci-minecraft-01',v_job_id,'stop_backend','leased','succeeded',v_lease_owner,gen_random_uuid(),'{"phase":"stopped"}'::jsonb
    );
    raise exception 'contract_invalid_transition_accepted';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform * from public.transition_mc_main_operation_job(
      'oci-minecraft-01',v_job_id,'stop_backend','leased','running','oci-minecraft-01:wrong-owner',gen_random_uuid(),'{"phase":"executing"}'::jsonb
    );
    raise exception 'contract_lease_owner_mismatch_accepted';
  exception when sqlstate '42501' then null;
  end;

  begin
    perform * from public.transition_mc_main_operation_job(
      'oci-minecraft-01',v_job_id,'stop_backend','leased','running',v_lease_owner,gen_random_uuid(),'{"phase":"executing","nested":{"token":"secret"}}'::jsonb
    );
    raise exception 'contract_sensitive_metadata_accepted';
  exception when sqlstate '22023' then null;
  end;

  perform * from public.transition_mc_main_operation_job(
    'oci-minecraft-01',v_job_id,'stop_backend','leased','running',v_lease_owner,gen_random_uuid(),'{"phase":"executing"}'::jsonb
  );

  -- Worker restart recovery: same owner gets the same running Job and a fresh lease.
  select lease_expires_at into v_old_expiry from public.operation_jobs where id=v_job_id;
  perform pg_sleep(0.01);
  select * into v_recovered from public.claim_mc_main_operation_job(
    'oci-minecraft-01',v_lease_owner,gen_random_uuid(),300
  );
  if v_recovered.job_id<>v_job_id or v_recovered.job_status<>'running' or v_recovered.lease_expires_at<=v_old_expiry then
    raise exception 'contract_inflight_recovery_failed';
  end if;

  perform * from public.transition_mc_main_operation_job(
    'oci-minecraft-01',v_job_id,'stop_backend','running','failed',v_lease_owner,gen_random_uuid(),'{"phase":"execution_failed","errorCode":"contract_cleanup"}'::jsonb
  );

  -- replay拒否
  select public.accept_operation_agent_request(
    'oci-minecraft-01','claim','0123456789abcdef0123456789abcdef',repeat('c',64)
  ) into v_bool;
  if not v_bool then raise exception 'contract_first_nonce_not_accepted'; end if;
  select public.accept_operation_agent_request(
    'oci-minecraft-01','claim','0123456789abcdef0123456789abcdef',repeat('c',64)
  ) into v_bool;
  if v_bool then raise exception 'contract_replay_not_rejected'; end if;

  -- expired lease recovery: stale leased Jobはexpiredへ回収
  select * into v_result from public.enqueue_discord_operation_job(
    v_operator_session,'oci-minecraft-01','start_backend','{}'::jsonb,repeat('d',64),null,gen_random_uuid()
  );
  select * into v_claim from public.claim_mc_main_operation_job(
    'oci-minecraft-01',v_lease_owner,gen_random_uuid(),15
  );
  update public.operation_jobs
     set leased_at=clock_timestamp()-interval '30 seconds',
         lease_expires_at=clock_timestamp()-interval '1 second'
   where id=v_claim.job_id;
  select public.expire_stale_operation_jobs(100) into v_count;
  select status into v_status from public.operation_jobs where id=v_claim.job_id;
  if v_count<1 or v_status<>'expired' then raise exception 'contract_expired_lease_not_recovered'; end if;
end;
$$;

rollback;
