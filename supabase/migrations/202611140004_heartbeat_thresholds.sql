-- Issue #230: heartbeat cadence moves from 15s to 60s
-- (IVRM_AGENT_INTERVAL on the agent hosts), so the scheduled
-- reconcile's heartbeat thresholds move with it: warning after
-- 150 seconds (about two missed beats) and critical after
-- 300 seconds (about five). With the old 45 second warning
-- threshold, a healthy 60 second cadence would sit in warning
-- permanently. Everything else in the function is unchanged
-- from migration 202611140002 (including the #218 suppression
-- wiring); the backup loop is untouched.

create or replace function public.reconcile_notification_scheduled_signals_v1()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_host record;
  v_backup record;
  v_age_seconds double precision;
  v_entity_key text;
  v_base_signal_key text;
  v_detail_href text;
  v_count integer := 0;
  v_console_disabled boolean := false;
begin
  -- Issue #218: a fresh probe reporting DEPLOYMENT_DISABLED means the
  -- heartbeat gaps are caused by the disabled Console ingest, so
  -- heartbeat signals are tracked silently until it clears.
  select health.deployment_disabled
  into v_console_disabled
  from public.console_ingest_health as health
  where health.id = 1
    and health.checked_at > clock_timestamp() - interval '10 minutes';
  v_console_disabled := coalesce(v_console_disabled, false);

  for v_host in
    select
      hosts.id as host_id,
      hosts.server_id,
      hosts.display_name,
      latest.received_at
    from public.hosts as hosts
    left join lateral (
      select heartbeats.received_at
      from public.agent_heartbeats as heartbeats
      where heartbeats.host_id = hosts.id
      order by heartbeats.received_at desc, heartbeats.id desc
      limit 1
    ) as latest on true
    where hosts.enabled
  loop
    if v_host.received_at is null then
      continue;
    end if;

    v_age_seconds := extract(epoch from (v_now - v_host.received_at));
    v_entity_key := v_host.host_id::text;
    v_detail_href := '/hosts/' || v_host.server_id || '?range=24h';

    if v_age_seconds > 150 then
      perform public.apply_notification_signal_v2(
        'host:' || v_host.host_id::text || ':heartbeat',
        'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
        'heartbeat', true, 'warning', v_host.received_at + interval '150 seconds',
        'Heartbeatが45秒以上更新されていません',
        v_host.display_name || ' / Heartbeat', v_detail_href, not v_console_disabled
      );
      v_count := v_count + 1;

      if v_age_seconds > 300 then
        perform public.apply_notification_signal_v2(
          'host:' || v_host.host_id::text || ':heartbeat',
          'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
          'heartbeat', true, 'critical', v_host.received_at + interval '300 seconds',
          'Heartbeatが180秒以上更新されていません',
          v_host.display_name || ' / Heartbeat', v_detail_href, not v_console_disabled
        );
      end if;
    else
      perform public.apply_notification_signal_v2(
        'host:' || v_host.host_id::text || ':heartbeat',
        'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
        'heartbeat', false, 'warning', v_host.received_at,
        'Heartbeat受信を確認しました',
        v_host.display_name || ' / Heartbeat', v_detail_href, not v_console_disabled
      );
    end if;
  end loop;

  for v_backup in
    select
      policies.id as policy_id,
      policies.host_id,
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
      success.completed_at,
      success.remote_synced_at,
      success.restore_tested_at,
      success.retention_expires_at
    from public.backup_policies as policies
    join public.hosts as hosts on hosts.id = policies.host_id and hosts.enabled
    left join lateral (
      select runs.completed_at, runs.remote_synced_at, runs.restore_tested_at, runs.retention_expires_at
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
  loop
    if v_backup.completed_at is null then
      continue;
    end if;

    v_entity_key := v_backup.host_id::text || ':' || v_backup.backup_target || ':' || v_backup.game_mode || ':' || v_backup.backup_type;
    v_base_signal_key := 'backup:' || v_entity_key;
    v_detail_href := '/backups?range=24h#backup-target-' || v_backup.host_id::text || '-' || v_backup.backup_target || '-' || v_backup.game_mode || '-' || v_backup.backup_type;
    v_age_seconds := extract(epoch from (v_now - v_backup.completed_at));

    if v_age_seconds > v_backup.warning_after_seconds then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':backup_age',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'backup_age', true, 'warning', v_backup.completed_at + make_interval(secs => v_backup.warning_after_seconds),
        '最新成功BackupがWarning SLAを超過しました',
        v_backup.backup_target || ' / Backup Age', v_detail_href
      );
      if v_age_seconds > v_backup.critical_after_seconds then
        perform public.apply_notification_signal_v1(
          v_base_signal_key || ':backup_age',
          'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
          'backup_age', true, 'critical', v_backup.completed_at + make_interval(secs => v_backup.critical_after_seconds),
          '最新成功BackupがCritical SLAを超過しました',
          v_backup.backup_target || ' / Backup Age', v_detail_href
        );
      end if;
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':backup_age',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'backup_age', false, 'warning', v_backup.completed_at,
        '最新成功BackupはSLA内です',
        v_backup.backup_target || ' / Backup Age', v_detail_href
      );
    end if;

    if v_backup.remote_sync_required
       and v_backup.remote_synced_at is null
       and v_now > v_backup.completed_at + make_interval(secs => v_backup.remote_sync_warning_seconds) then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':remote_sync',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'remote_sync', true, 'warning', v_backup.completed_at + make_interval(secs => v_backup.remote_sync_warning_seconds),
        'Remote SyncがSLA内に完了していません',
        v_backup.backup_target || ' / Remote Sync', v_detail_href
      );
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':remote_sync',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'remote_sync', false, 'warning', coalesce(v_backup.remote_synced_at, v_backup.completed_at),
        case when v_backup.remote_sync_required then 'Remote Sync完了を確認しました' else 'Remote Syncは必須ではありません' end,
        v_backup.backup_target || ' / Remote Sync', v_detail_href
      );
    end if;

    if v_backup.retention_expires_at is not null and v_backup.retention_expires_at <= v_now then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':retention',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'retention', true, 'critical', v_backup.retention_expires_at,
        '最新成功BackupのRetention期限を超過しました',
        v_backup.backup_target || ' / Retention', v_detail_href
      );
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':retention',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'retention', false, 'warning', v_backup.completed_at,
        'Retention期限は有効です',
        v_backup.backup_target || ' / Retention', v_detail_href
      );
    end if;

    if v_backup.restore_tested_at is null then
      if v_now > v_backup.completed_at + make_interval(secs => v_backup.restore_test_warning_seconds) then
        perform public.apply_notification_signal_v1(
          v_base_signal_key || ':restore_test',
          'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
          'restore_test', true, 'warning', v_backup.completed_at + make_interval(secs => v_backup.restore_test_warning_seconds),
          'Restore Testが長期間実施されていません',
          v_backup.backup_target || ' / Restore Test', v_detail_href
        );
      else
        perform public.apply_notification_signal_v1(
          v_base_signal_key || ':restore_test',
          'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
          'restore_test', false, 'warning', v_backup.completed_at,
          'Restore Test警告SLA内です',
          v_backup.backup_target || ' / Restore Test', v_detail_href
        );
      end if;
    elsif v_now > v_backup.restore_tested_at + make_interval(secs => v_backup.restore_test_warning_seconds) then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':restore_test',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'restore_test', true, 'warning', v_backup.restore_tested_at + make_interval(secs => v_backup.restore_test_warning_seconds),
        'Restore Testの鮮度がWarning SLAを超過しました',
        v_backup.backup_target || ' / Restore Test', v_detail_href
      );
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':restore_test',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'restore_test', false, 'warning', v_backup.restore_tested_at,
        'Restore Testの鮮度を確認しました',
        v_backup.backup_target || ' / Restore Test', v_detail_href
      );
    end if;
  end loop;

  return v_count;
end;
$$;
