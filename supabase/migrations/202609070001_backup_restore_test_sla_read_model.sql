-- Issue #117
-- Restore Test is policy-scoped evidence with its own SLA. Keep the evidence on
-- the run that was actually restored, while exposing the newest successful
-- restore test for the policy through the existing Backup Center read model.
--
-- SHA-256, Remote Sync and Retention remain attributes of the latest successful
-- artifact. This avoids copying evidence onto a run that was never tested and
-- keeps the existing RPC return shape/API compatible.

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
    restore_evidence.restore_tested_at,
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
  left join lateral (
    select runs.restore_tested_at
    from public.backup_runs as runs
    where runs.host_id = policies.host_id
      and runs.backup_target = policies.backup_target
      and runs.game_mode = policies.game_mode
      and runs.backup_type = policies.backup_type
      and runs.outcome = 'success'
      and runs.completed_at is not null
      and runs.restore_tested_at is not null
    order by runs.restore_tested_at desc, runs.id desc
    limit 1
  ) as restore_evidence on true
  where policies.enabled
    and hosts.enabled
  order by hosts.display_name, policies.backup_target, policies.game_mode, policies.backup_type;
$$;

revoke all on function public.get_backup_center_v1()
  from public, anon, authenticated;
grant execute on function public.get_backup_center_v1()
  to service_role;

comment on function public.get_backup_center_v1() is
  '有効なBackup Policyごとに最新Run・最新成功Runと、同一Policy内の最新成功Restore Test evidenceを返すService Role専用RPC。';
