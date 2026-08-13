create table if not exists public.backup_policies (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  backup_target text not null,
  game_mode text not null,
  backup_type text not null,
  remote_sync_required boolean not null default false,
  enabled boolean not null default true,
  warning_after_seconds integer not null default 86400,
  critical_after_seconds integer not null default 172800,
  remote_sync_warning_seconds integer not null default 21600,
  restore_test_warning_seconds integer not null default 2592000,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint backup_policies_target_check
    check (backup_target ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint backup_policies_game_mode_check
    check (game_mode ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint backup_policies_type_check
    check (backup_type in ('world', 'config', 'permissions', 'full')),
  constraint backup_policies_sla_check
    check (
      warning_after_seconds between 60 and 2592000
      and critical_after_seconds between 120 and 7776000
      and critical_after_seconds > warning_after_seconds
      and remote_sync_warning_seconds between 60 and 2592000
      and restore_test_warning_seconds between 3600 and 31536000
    ),
  unique (host_id, backup_target, game_mode, backup_type)
);

create table if not exists public.backup_runs (
  id bigint generated always as identity primary key,
  run_id uuid not null,
  host_id uuid not null references public.hosts(id) on delete cascade,
  backup_target text not null,
  game_mode text not null,
  backup_type text not null,
  destination_type text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  outcome text not null,
  duration_seconds integer,
  size_bytes bigint,
  sha256_verified boolean,
  remote_synced_at timestamptz,
  restore_tested_at timestamptz,
  retention_expires_at timestamptz,
  failure_code text,
  first_reported_at timestamptz not null default clock_timestamp(),
  last_reported_at timestamptz not null default clock_timestamp(),
  constraint backup_runs_target_check
    check (backup_target ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint backup_runs_game_mode_check
    check (game_mode ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'),
  constraint backup_runs_type_check
    check (backup_type in ('world', 'config', 'permissions', 'full')),
  constraint backup_runs_destination_check
    check (destination_type in ('local', 's3')),
  constraint backup_runs_outcome_check
    check (outcome in ('success', 'failed', 'running', 'unknown')),
  constraint backup_runs_duration_check
    check (duration_seconds is null or duration_seconds between 0 and 604800),
  constraint backup_runs_size_check
    check (size_bytes is null or size_bytes between 0 and 9007199254740991),
  constraint backup_runs_failure_code_check
    check (
      failure_code is null
      or failure_code in (
        'source_unavailable',
        'archive_failed',
        'checksum_failed',
        'remote_sync_failed',
        'retention_failed',
        'timeout',
        'permission_denied',
        'insufficient_space',
        'unknown'
      )
    ),
  constraint backup_runs_completion_check
    check (
      (
        outcome in ('success', 'failed')
        and completed_at is not null
        and duration_seconds is not null
        and completed_at >= started_at
      )
      or (
        outcome in ('running', 'unknown')
        and completed_at is null
        and duration_seconds is null
      )
    ),
  constraint backup_runs_failure_required_check
    check (
      (outcome = 'failed' and failure_code is not null)
      or (outcome <> 'failed' and failure_code is null)
    ),
  constraint backup_runs_remote_sync_order_check
    check (remote_synced_at is null or (completed_at is not null and remote_synced_at >= completed_at)),
  constraint backup_runs_restore_order_check
    check (restore_tested_at is null or (completed_at is not null and restore_tested_at >= completed_at)),
  constraint backup_runs_retention_order_check
    check (retention_expires_at is null or (completed_at is not null and retention_expires_at > completed_at)),
  unique (host_id, run_id)
);

create table if not exists public.backup_ingest_requests (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  received_at timestamptz not null default clock_timestamp(),
  reported_at timestamptz not null,
  request_nonce text not null,
  body_sha256 text not null,
  run_count integer not null,
  constraint backup_ingest_requests_nonce_check
    check (request_nonce ~ '^[a-f0-9]{32}$'),
  constraint backup_ingest_requests_sha_check
    check (body_sha256 ~ '^[a-f0-9]{64}$'),
  constraint backup_ingest_requests_count_check
    check (run_count between 1 and 20),
  unique (request_nonce)
);

create index if not exists backup_policies_host_enabled_idx
  on public.backup_policies (host_id, enabled, backup_target, game_mode, backup_type);

create index if not exists backup_runs_host_completed_idx
  on public.backup_runs (host_id, completed_at desc, id desc)
  where completed_at is not null;

create index if not exists backup_runs_target_started_idx
  on public.backup_runs (
    host_id,
    backup_target,
    game_mode,
    backup_type,
    started_at desc,
    id desc
  );

create index if not exists backup_ingest_requests_host_received_idx
  on public.backup_ingest_requests (host_id, received_at desc);

alter table public.backup_policies enable row level security;
alter table public.backup_policies force row level security;
alter table public.backup_runs enable row level security;
alter table public.backup_runs force row level security;
alter table public.backup_ingest_requests enable row level security;
alter table public.backup_ingest_requests force row level security;

revoke all on table public.backup_policies from public, anon, authenticated, service_role;
revoke all on table public.backup_runs from public, anon, authenticated, service_role;
revoke all on table public.backup_ingest_requests from public, anon, authenticated, service_role;

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
      host_id,
      reported_at,
      request_nonce,
      body_sha256,
      run_count
    ) values (
      v_host_id,
      p_reported_at,
      p_request_nonce,
      p_body_sha256,
      v_run_count
    );
  exception
    when unique_violation then
      return 'replayed_request';
  end;

  for v_run in select value from jsonb_array_elements(p_runs)
  loop
    if jsonb_typeof(v_run) <> 'object'
      or not (v_run ? 'runId')
      or not (v_run ? 'backupTarget')
      or not (v_run ? 'gameMode')
      or not (v_run ? 'backupType')
      or not (v_run ? 'destinationType')
      or not (v_run ? 'startedAt')
      or not (v_run ? 'outcome') then
      return 'invalid_payload';
    end if;

    begin
      v_run_id := (v_run->>'runId')::uuid;
      v_backup_target := v_run->>'backupTarget';
      v_game_mode := v_run->>'gameMode';
      v_backup_type := v_run->>'backupType';
      v_destination_type := v_run->>'destinationType';
      v_started_at := (v_run->>'startedAt')::timestamptz;
      v_outcome := v_run->>'outcome';
      v_completed_at := case
        when v_run ? 'completedAt' and v_run->'completedAt' <> 'null'::jsonb
          then (v_run->>'completedAt')::timestamptz
        else null
      end;
      v_duration_seconds := case
        when v_run ? 'durationSeconds' and v_run->'durationSeconds' <> 'null'::jsonb
          then (v_run->>'durationSeconds')::integer
        else null
      end;
      v_size_bytes := case
        when v_run ? 'sizeBytes' and v_run->'sizeBytes' <> 'null'::jsonb
          then (v_run->>'sizeBytes')::bigint
        else null
      end;
      v_sha256_verified := case
        when v_run ? 'sha256Verified' and v_run->'sha256Verified' <> 'null'::jsonb
          then (v_run->>'sha256Verified')::boolean
        else null
      end;
      v_remote_synced_at := case
        when v_run ? 'remoteSyncedAt' and v_run->'remoteSyncedAt' <> 'null'::jsonb
          then (v_run->>'remoteSyncedAt')::timestamptz
        else null
      end;
      v_restore_tested_at := case
        when v_run ? 'restoreTestedAt' and v_run->'restoreTestedAt' <> 'null'::jsonb
          then (v_run->>'restoreTestedAt')::timestamptz
        else null
      end;
      v_retention_expires_at := case
        when v_run ? 'retentionExpiresAt' and v_run->'retentionExpiresAt' <> 'null'::jsonb
          then (v_run->>'retentionExpiresAt')::timestamptz
        else null
      end;
      v_failure_code := case
        when v_run ? 'failureCode' and v_run->'failureCode' <> 'null'::jsonb
          then v_run->>'failureCode'
        else null
      end;
    exception when others then
      return 'invalid_payload';
    end;

    if v_backup_target is null
      or v_backup_target !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
      or v_game_mode is null
      or v_game_mode !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
      or v_backup_type not in ('world', 'config', 'permissions', 'full')
      or v_destination_type not in ('local', 's3')
      or v_outcome not in ('success', 'failed', 'running', 'unknown')
      or v_started_at is null
      or v_started_at > p_reported_at + interval '5 minutes'
      or v_started_at < p_reported_at - interval '90 days'
      or (v_duration_seconds is not null and (v_duration_seconds < 0 or v_duration_seconds > 604800))
      or (v_size_bytes is not null and (v_size_bytes < 0 or v_size_bytes > 9007199254740991))
      or (v_outcome in ('success', 'failed') and (v_completed_at is null or v_duration_seconds is null))
      or (v_outcome in ('running', 'unknown') and (v_completed_at is not null or v_duration_seconds is not null))
      or (v_completed_at is not null and (v_completed_at < v_started_at or v_completed_at > p_reported_at + interval '5 minutes'))
      or (v_outcome = 'failed' and v_failure_code is null)
      or (v_outcome <> 'failed' and v_failure_code is not null)
      or (v_failure_code is not null and v_failure_code not in (
        'source_unavailable',
        'archive_failed',
        'checksum_failed',
        'remote_sync_failed',
        'retention_failed',
        'timeout',
        'permission_denied',
        'insufficient_space',
        'unknown'
      ))
      or (v_remote_synced_at is not null and (v_completed_at is null or v_remote_synced_at < v_completed_at or v_remote_synced_at > p_reported_at + interval '5 minutes'))
      or (v_restore_tested_at is not null and (v_completed_at is null or v_restore_tested_at < v_completed_at or v_restore_tested_at > p_reported_at + interval '5 minutes'))
      or (v_retention_expires_at is not null and (v_completed_at is null or v_retention_expires_at <= v_completed_at)) then
      return 'invalid_payload';
    end if;

    insert into public.backup_policies (
      host_id,
      backup_target,
      game_mode,
      backup_type,
      remote_sync_required
    ) values (
      v_host_id,
      v_backup_target,
      v_game_mode,
      v_backup_type,
      v_destination_type = 's3'
    )
    on conflict (host_id, backup_target, game_mode, backup_type)
    do update set
      remote_sync_required = public.backup_policies.remote_sync_required or excluded.remote_sync_required,
      updated_at = clock_timestamp();

    insert into public.backup_runs (
      run_id,
      host_id,
      backup_target,
      game_mode,
      backup_type,
      destination_type,
      started_at,
      completed_at,
      outcome,
      duration_seconds,
      size_bytes,
      sha256_verified,
      remote_synced_at,
      restore_tested_at,
      retention_expires_at,
      failure_code
    ) values (
      v_run_id,
      v_host_id,
      v_backup_target,
      v_game_mode,
      v_backup_type,
      v_destination_type,
      v_started_at,
      v_completed_at,
      v_outcome,
      v_duration_seconds,
      v_size_bytes,
      v_sha256_verified,
      v_remote_synced_at,
      v_restore_tested_at,
      v_retention_expires_at,
      v_failure_code
    )
    on conflict (host_id, run_id)
    do update set
      last_reported_at = clock_timestamp(),
      destination_type = excluded.destination_type,
      outcome = case
        when public.backup_runs.outcome in ('success', 'failed')
          then public.backup_runs.outcome
        else excluded.outcome
      end,
      completed_at = case
        when public.backup_runs.outcome in ('success', 'failed')
          then public.backup_runs.completed_at
        else excluded.completed_at
      end,
      duration_seconds = case
        when public.backup_runs.outcome in ('success', 'failed')
          then public.backup_runs.duration_seconds
        else excluded.duration_seconds
      end,
      failure_code = case
        when public.backup_runs.outcome in ('success', 'failed')
          then public.backup_runs.failure_code
        else excluded.failure_code
      end,
      size_bytes = coalesce(excluded.size_bytes, public.backup_runs.size_bytes),
      sha256_verified = coalesce(excluded.sha256_verified, public.backup_runs.sha256_verified),
      remote_synced_at = coalesce(excluded.remote_synced_at, public.backup_runs.remote_synced_at),
      restore_tested_at = coalesce(excluded.restore_tested_at, public.backup_runs.restore_tested_at),
      retention_expires_at = coalesce(excluded.retention_expires_at, public.backup_runs.retention_expires_at);
  end loop;

  return 'accepted';
end;
$$;

create or replace function public.get_backup_center_v1()
returns table (
  policy_id bigint,
  host_id uuid,
  server_id text,
  host_display_name text,
  backup_target text,
  game_mode text,
  backup_type text,
  remote_sync_required boolean,
  warning_after_seconds integer,
  critical_after_seconds integer,
  remote_sync_warning_seconds integer,
  restore_test_warning_seconds integer,
  latest_run_id uuid,
  latest_outcome text,
  latest_started_at timestamptz,
  latest_completed_at timestamptz,
  latest_duration_seconds integer,
  latest_size_bytes bigint,
  latest_sha256_verified boolean,
  latest_destination_type text,
  latest_remote_synced_at timestamptz,
  latest_restore_tested_at timestamptz,
  latest_retention_expires_at timestamptz,
  latest_failure_code text,
  latest_success_run_id uuid,
  latest_success_at timestamptz,
  latest_success_size_bytes bigint,
  latest_success_sha256_verified boolean,
  latest_success_destination_type text,
  latest_success_remote_synced_at timestamptz,
  latest_success_restore_tested_at timestamptz,
  latest_success_retention_expires_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select
    policies.id,
    hosts.id,
    hosts.server_id,
    hosts.display_name,
    policies.backup_target,
    policies.game_mode,
    policies.backup_type,
    policies.remote_sync_required,
    policies.warning_after_seconds,
    policies.critical_after_seconds,
    policies.remote_sync_warning_seconds,
    policies.restore_test_warning_seconds,
    latest.run_id,
    latest.outcome,
    latest.started_at,
    latest.completed_at,
    latest.duration_seconds,
    latest.size_bytes,
    latest.sha256_verified,
    latest.destination_type,
    latest.remote_synced_at,
    latest.restore_tested_at,
    latest.retention_expires_at,
    latest.failure_code,
    success.run_id,
    success.completed_at,
    success.size_bytes,
    success.sha256_verified,
    success.destination_type,
    success.remote_synced_at,
    success.restore_tested_at,
    success.retention_expires_at
  from public.backup_policies as policies
  join public.hosts as hosts on hosts.id = policies.host_id
  left join lateral (
    select runs.*
    from public.backup_runs as runs
    where runs.host_id = policies.host_id
      and runs.backup_target = policies.backup_target
      and runs.game_mode = policies.game_mode
      and runs.backup_type = policies.backup_type
    order by runs.started_at desc, runs.id desc
    limit 1
  ) as latest on true
  left join lateral (
    select runs.*
    from public.backup_runs as runs
    where runs.host_id = policies.host_id
      and runs.backup_target = policies.backup_target
      and runs.game_mode = policies.game_mode
      and runs.backup_type = policies.backup_type
      and runs.outcome = 'success'
      and runs.completed_at is not null
    order by runs.completed_at desc, runs.id desc
    limit 1
  ) as success on true
  where policies.enabled
    and hosts.enabled
  order by hosts.display_name, policies.backup_target, policies.game_mode, policies.backup_type;
$$;

create or replace function public.get_backup_runs_v1(
  p_range text default '24h',
  p_limit integer default 500
)
returns table (
  row_id bigint,
  run_id uuid,
  host_id uuid,
  server_id text,
  host_display_name text,
  backup_target text,
  game_mode text,
  backup_type text,
  destination_type text,
  started_at timestamptz,
  completed_at timestamptz,
  outcome text,
  duration_seconds integer,
  size_bytes bigint,
  sha256_verified boolean,
  remote_synced_at timestamptz,
  restore_tested_at timestamptz,
  retention_expires_at timestamptz,
  failure_code text
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_since timestamptz;
begin
  if p_range not in ('24h', '7d', '30d')
    or p_limit is null
    or p_limit < 1
    or p_limit > 1000 then
    raise exception 'backup_history_query_invalid' using errcode = '22023';
  end if;

  v_since := clock_timestamp() - case p_range
    when '24h' then interval '24 hours'
    when '7d' then interval '7 days'
    else interval '30 days'
  end;

  return query
  select
    runs.id,
    runs.run_id,
    runs.host_id,
    hosts.server_id,
    hosts.display_name,
    runs.backup_target,
    runs.game_mode,
    runs.backup_type,
    runs.destination_type,
    runs.started_at,
    runs.completed_at,
    runs.outcome,
    runs.duration_seconds,
    runs.size_bytes,
    runs.sha256_verified,
    runs.remote_synced_at,
    runs.restore_tested_at,
    runs.retention_expires_at,
    runs.failure_code
  from public.backup_runs as runs
  join public.hosts as hosts on hosts.id = runs.host_id
  where coalesce(runs.completed_at, runs.started_at) >= v_since
  order by runs.started_at desc, runs.id desc
  limit p_limit;
end;
$$;

revoke all on function public.ingest_backup_report_v1(text, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.get_backup_center_v1()
  from public, anon, authenticated;
revoke all on function public.get_backup_runs_v1(text, integer)
  from public, anon, authenticated;

grant execute on function public.ingest_backup_report_v1(text, timestamptz, text, text, jsonb)
  to service_role;
grant execute on function public.get_backup_center_v1()
  to service_role;
grant execute on function public.get_backup_runs_v1(text, integer)
  to service_role;

comment on table public.backup_policies is
  'Backup Centerの対象とSLA。初回の構造化Backup Reportから安全な既定値で自動登録する。';
comment on table public.backup_runs is
  'Secret・Path・raw logを含まない構造化バックアップ実行履歴。';
comment on table public.backup_ingest_requests is
  '署名検証済みBackup ReportのReplay防止用受信記録。';
comment on function public.ingest_backup_report_v1(text, timestamptz, text, text, jsonb) is
  '署名検証後のBackup ReportをHostロック・Nonce冪等性の下で保存する。';
comment on function public.get_backup_center_v1() is
  '有効なBackup Policyごとに最新Runと最新成功Runを返すService Role専用RPC。';
comment on function public.get_backup_runs_v1(text, integer) is
  '24h/7d/30dの構造化Backup履歴を最大1000件まで返すService Role専用RPC。';
