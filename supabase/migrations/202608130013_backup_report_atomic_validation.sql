create or replace function public.backup_run_is_valid_v1(
  p_run jsonb,
  p_reported_at timestamptz
)
returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_run_id uuid;
  v_backup_target text;
  v_game_mode text;
  v_backup_type text;
  v_destination_type text;
  v_started_at timestamptz;
  v_completed_at timestamptz;
  v_outcome text;
  v_duration_seconds integer;
  v_size_bytes bigint;
  v_remote_synced_at timestamptz;
  v_restore_tested_at timestamptz;
  v_retention_expires_at timestamptz;
  v_failure_code text;
begin
  if p_run is null
    or jsonb_typeof(p_run) <> 'object'
    or not (p_run ? 'runId')
    or not (p_run ? 'backupTarget')
    or not (p_run ? 'gameMode')
    or not (p_run ? 'backupType')
    or not (p_run ? 'destinationType')
    or not (p_run ? 'startedAt')
    or not (p_run ? 'outcome')
    or exists (
      select 1
      from jsonb_object_keys(p_run) as keys(key)
      where keys.key not in (
        'runId', 'backupTarget', 'gameMode', 'backupType', 'destinationType',
        'startedAt', 'completedAt', 'outcome', 'durationSeconds', 'sizeBytes',
        'sha256Verified', 'remoteSyncedAt', 'restoreTestedAt',
        'retentionExpiresAt', 'failureCode'
      )
    ) then
    return false;
  end if;

  begin
    v_run_id := (p_run->>'runId')::uuid;
    v_backup_target := p_run->>'backupTarget';
    v_game_mode := p_run->>'gameMode';
    v_backup_type := p_run->>'backupType';
    v_destination_type := p_run->>'destinationType';
    v_started_at := (p_run->>'startedAt')::timestamptz;
    v_outcome := p_run->>'outcome';
    v_completed_at := case
      when p_run ? 'completedAt' and p_run->'completedAt' <> 'null'::jsonb
        then (p_run->>'completedAt')::timestamptz
      else null
    end;
    v_duration_seconds := case
      when p_run ? 'durationSeconds' and p_run->'durationSeconds' <> 'null'::jsonb
        then (p_run->>'durationSeconds')::integer
      else null
    end;
    v_size_bytes := case
      when p_run ? 'sizeBytes' and p_run->'sizeBytes' <> 'null'::jsonb
        then (p_run->>'sizeBytes')::bigint
      else null
    end;
    if p_run ? 'sha256Verified'
      and p_run->'sha256Verified' <> 'null'::jsonb
      and jsonb_typeof(p_run->'sha256Verified') <> 'boolean' then
      return false;
    end if;
    v_remote_synced_at := case
      when p_run ? 'remoteSyncedAt' and p_run->'remoteSyncedAt' <> 'null'::jsonb
        then (p_run->>'remoteSyncedAt')::timestamptz
      else null
    end;
    v_restore_tested_at := case
      when p_run ? 'restoreTestedAt' and p_run->'restoreTestedAt' <> 'null'::jsonb
        then (p_run->>'restoreTestedAt')::timestamptz
      else null
    end;
    v_retention_expires_at := case
      when p_run ? 'retentionExpiresAt' and p_run->'retentionExpiresAt' <> 'null'::jsonb
        then (p_run->>'retentionExpiresAt')::timestamptz
      else null
    end;
    v_failure_code := case
      when p_run ? 'failureCode' and p_run->'failureCode' <> 'null'::jsonb
        then p_run->>'failureCode'
      else null
    end;
  exception when others then
    return false;
  end;

  return v_run_id is not null
    and v_backup_target ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    and v_game_mode ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
    and v_backup_type in ('world', 'config', 'permissions', 'full')
    and v_destination_type in ('local', 's3')
    and v_outcome in ('success', 'failed', 'running', 'unknown')
    and v_started_at is not null
    and v_started_at <= p_reported_at + interval '5 minutes'
    and v_started_at >= p_reported_at - interval '90 days'
    and (v_duration_seconds is null or v_duration_seconds between 0 and 604800)
    and (v_size_bytes is null or v_size_bytes between 0 and 9007199254740991)
    and (
      (v_outcome in ('success', 'failed') and v_completed_at is not null and v_duration_seconds is not null)
      or (v_outcome in ('running', 'unknown') and v_completed_at is null and v_duration_seconds is null)
    )
    and (v_completed_at is null or (
      v_completed_at >= v_started_at
      and v_completed_at <= p_reported_at + interval '5 minutes'
    ))
    and ((v_outcome = 'failed' and v_failure_code is not null) or (v_outcome <> 'failed' and v_failure_code is null))
    and (v_failure_code is null or v_failure_code in (
      'source_unavailable', 'archive_failed', 'checksum_failed',
      'remote_sync_failed', 'retention_failed', 'timeout',
      'permission_denied', 'insufficient_space', 'unknown'
    ))
    and (v_remote_synced_at is null or (
      v_completed_at is not null
      and v_remote_synced_at >= v_completed_at
      and v_remote_synced_at <= p_reported_at + interval '5 minutes'
    ))
    and (v_restore_tested_at is null or (
      v_completed_at is not null
      and v_restore_tested_at >= v_completed_at
      and v_restore_tested_at <= p_reported_at + interval '5 minutes'
    ))
    and (v_retention_expires_at is null or (
      v_completed_at is not null
      and v_retention_expires_at > v_completed_at
    ));
end;
$$;

create or replace function public.ingest_backup_report_v1(
  p_server_id text,
  p_reported_at timestamptz,
  p_request_nonce text,
  p_body_sha256 text,
  p_runs jsonb
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_host_id uuid;
  v_enabled boolean;
  v_latest_received_at timestamptz;
  v_run jsonb;
  v_run_id uuid;
  v_backup_target text;
  v_game_mode text;
  v_backup_type text;
  v_destination_type text;
  v_started_at timestamptz;
  v_completed_at timestamptz;
  v_outcome text;
  v_duration_seconds integer;
  v_size_bytes bigint;
  v_sha256_verified boolean;
  v_remote_synced_at timestamptz;
  v_restore_tested_at timestamptz;
  v_retention_expires_at timestamptz;
  v_failure_code text;
  v_run_count integer;
begin
  if p_server_id is null
    or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
    or p_reported_at is null
    or abs(extract(epoch from (clock_timestamp() - p_reported_at))) > 300
    or p_request_nonce is null
    or p_request_nonce !~ '^[a-f0-9]{32}$'
    or p_body_sha256 is null
    or p_body_sha256 !~ '^[a-f0-9]{64}$'
    or p_runs is null
    or jsonb_typeof(p_runs) <> 'array' then
    return 'invalid_payload';
  end if;

  v_run_count := jsonb_array_length(p_runs);
  if v_run_count < 1 or v_run_count > 20 then
    return 'invalid_payload';
  end if;

  for v_run in select value from jsonb_array_elements(p_runs)
  loop
    if not public.backup_run_is_valid_v1(v_run, p_reported_at) then
      return 'invalid_payload';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct value->>'runId')
    from jsonb_array_elements(p_runs)
  ) then
    return 'invalid_payload';
  end if;

  select hosts.id, hosts.enabled
  into v_host_id, v_enabled
  from public.hosts as hosts
  where hosts.server_id = p_server_id
  for update;

  if not found or not v_enabled then
    return 'unknown_agent';
  end if;

  select requests.received_at
  into v_latest_received_at
  from public.backup_ingest_requests as requests
  where requests.host_id = v_host_id
  order by requests.received_at desc
  limit 1;

  if v_latest_received_at is not null
    and clock_timestamp() - v_latest_received_at < interval '1 second' then
    return 'rate_limited';
  end if;

  begin
    insert into public.backup_ingest_requests (
      host_id, reported_at, request_nonce, body_sha256, run_count
    ) values (
      v_host_id, p_reported_at, p_request_nonce, p_body_sha256, v_run_count
    );
  exception
    when unique_violation then
      return 'replayed_request';
  end;

  for v_run in select value from jsonb_array_elements(p_runs)
  loop
    v_run_id := (v_run->>'runId')::uuid;
    v_backup_target := v_run->>'backupTarget';
    v_game_mode := v_run->>'gameMode';
    v_backup_type := v_run->>'backupType';
    v_destination_type := v_run->>'destinationType';
    v_started_at := (v_run->>'startedAt')::timestamptz;
    v_outcome := v_run->>'outcome';
    v_completed_at := case when v_run ? 'completedAt' and v_run->'completedAt' <> 'null'::jsonb then (v_run->>'completedAt')::timestamptz else null end;
    v_duration_seconds := case when v_run ? 'durationSeconds' and v_run->'durationSeconds' <> 'null'::jsonb then (v_run->>'durationSeconds')::integer else null end;
    v_size_bytes := case when v_run ? 'sizeBytes' and v_run->'sizeBytes' <> 'null'::jsonb then (v_run->>'sizeBytes')::bigint else null end;
    v_sha256_verified := case when v_run ? 'sha256Verified' and v_run->'sha256Verified' <> 'null'::jsonb then (v_run->>'sha256Verified')::boolean else null end;
    v_remote_synced_at := case when v_run ? 'remoteSyncedAt' and v_run->'remoteSyncedAt' <> 'null'::jsonb then (v_run->>'remoteSyncedAt')::timestamptz else null end;
    v_restore_tested_at := case when v_run ? 'restoreTestedAt' and v_run->'restoreTestedAt' <> 'null'::jsonb then (v_run->>'restoreTestedAt')::timestamptz else null end;
    v_retention_expires_at := case when v_run ? 'retentionExpiresAt' and v_run->'retentionExpiresAt' <> 'null'::jsonb then (v_run->>'retentionExpiresAt')::timestamptz else null end;
    v_failure_code := case when v_run ? 'failureCode' and v_run->'failureCode' <> 'null'::jsonb then v_run->>'failureCode' else null end;

    insert into public.backup_policies (
      host_id, backup_target, game_mode, backup_type, remote_sync_required
    ) values (
      v_host_id, v_backup_target, v_game_mode, v_backup_type, v_destination_type = 's3'
    )
    on conflict (host_id, backup_target, game_mode, backup_type)
    do update set
      remote_sync_required = public.backup_policies.remote_sync_required or excluded.remote_sync_required,
      updated_at = clock_timestamp();

    insert into public.backup_runs (
      run_id, host_id, backup_target, game_mode, backup_type, destination_type,
      started_at, completed_at, outcome, duration_seconds, size_bytes,
      sha256_verified, remote_synced_at, restore_tested_at,
      retention_expires_at, failure_code
    ) values (
      v_run_id, v_host_id, v_backup_target, v_game_mode, v_backup_type,
      v_destination_type, v_started_at, v_completed_at, v_outcome,
      v_duration_seconds, v_size_bytes, v_sha256_verified, v_remote_synced_at,
      v_restore_tested_at, v_retention_expires_at, v_failure_code
    )
    on conflict (host_id, run_id)
    do update set
      last_reported_at = clock_timestamp(),
      destination_type = excluded.destination_type,
      outcome = case when public.backup_runs.outcome in ('success', 'failed') then public.backup_runs.outcome else excluded.outcome end,
      completed_at = case when public.backup_runs.outcome in ('success', 'failed') then public.backup_runs.completed_at else excluded.completed_at end,
      duration_seconds = case when public.backup_runs.outcome in ('success', 'failed') then public.backup_runs.duration_seconds else excluded.duration_seconds end,
      failure_code = case when public.backup_runs.outcome in ('success', 'failed') then public.backup_runs.failure_code else excluded.failure_code end,
      size_bytes = coalesce(excluded.size_bytes, public.backup_runs.size_bytes),
      sha256_verified = coalesce(excluded.sha256_verified, public.backup_runs.sha256_verified),
      remote_synced_at = coalesce(excluded.remote_synced_at, public.backup_runs.remote_synced_at),
      restore_tested_at = coalesce(excluded.restore_tested_at, public.backup_runs.restore_tested_at),
      retention_expires_at = coalesce(excluded.retention_expires_at, public.backup_runs.retention_expires_at);
  end loop;

  return 'accepted';
end;
$$;

revoke all on function public.backup_run_is_valid_v1(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_backup_report_v1(text, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_backup_report_v1(text, timestamptz, text, text, jsonb)
  to service_role;

comment on function public.backup_run_is_valid_v1(jsonb, timestamptz) is
  'Backup Runの許可キー・型・enum・時刻順序をDB変更前に検証する内部Helper。';
comment on function public.ingest_backup_report_v1(text, timestamptz, text, text, jsonb) is
  '全Run検証後にReplay記録とBackup Runを原子的に保存し、無効PayloadではDBを変更しない。';
