-- Issue #218 (Phase 2 of #215): while the Console ingest is known to be
-- disabled (fresh console_ingest_health probe reporting
-- DEPLOYMENT_DISABLED), host heartbeat signals are tracked silently
-- instead of paging once per host. Mirrors the cloud-side v2 pattern
-- from 202611140001: silent tracking while suppressed, a single
-- catch-up "opened" once notifications resume, and no recovery
-- announcement for episodes that were never announced.

create or replace function public.apply_notification_signal_v2(
  p_signal_key text,
  p_source_type text,
  p_host_id uuid,
  p_server_id text,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_signal_type text,
  p_active boolean,
  p_severity text,
  p_occurred_at timestamptz,
  p_reason text,
  p_title text,
  p_detail_href text,
  p_notify boolean
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current public.notification_signal_state%rowtype;
  v_transition text;
  v_dedupe_key text;
  v_delivery_severity text;
  v_title text;
  v_episode_opened_at timestamptz;
  v_announced boolean;
begin
  if p_signal_key is null or char_length(p_signal_key) not between 1 and 500
    or p_source_type is null or p_source_type not in ('host', 'container', 'backup')
    or p_host_id is null
    or p_server_id is null or char_length(p_server_id) not between 1 and 128
    or p_entity_type is null or p_entity_type not in ('host', 'container', 'backup')
    or p_entity_key is null or char_length(p_entity_key) not between 1 and 400
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_signal_type is null or char_length(p_signal_type) not between 1 and 80
    or p_active is null
    or p_severity is null or p_severity not in ('warning', 'critical')
    or p_occurred_at is null
    or p_reason is null or char_length(p_reason) not between 1 and 1800
    or p_title is null or char_length(p_title) not between 1 and 140
    or p_detail_href is null
    or char_length(p_detail_href) > 1001
    or p_detail_href !~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
    or p_notify is null then
    raise exception 'notification_signal_invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_signal_key, 0));

  select * into v_current
  from public.notification_signal_state
  where signal_key = p_signal_key
  for update;

  if found and p_occurred_at < v_current.last_seen_at then
    return 'stale_ignored';
  end if;

  -- Episode start: a fresh insert or a reopen starts a new episode at
  -- p_occurred_at; an already-active signal keeps its opened_at.
  v_episode_opened_at := case
    when not found then p_occurred_at
    when not v_current.active then p_occurred_at
    else v_current.opened_at
  end;
  v_announced := exists (
    select 1
    from public.notification_outbox as outbox
    where outbox.signal_key = p_signal_key
      and outbox.transition in ('opened', 'escalated')
      and outbox.occurred_at >= v_episode_opened_at
  );

  if p_active then
    if not found then
      insert into public.notification_signal_state (
        signal_key, source_type, host_id, server_id, entity_type, entity_key,
        entity_name, signal_type, severity, active, opened_at, last_seen_at,
        recovered_at, reason, detail_href
      ) values (
        p_signal_key, p_source_type, p_host_id, p_server_id, p_entity_type, p_entity_key,
        p_entity_name, p_signal_type, p_severity, true, p_occurred_at, p_occurred_at,
        null, p_reason, p_detail_href
      );
      v_transition := 'opened';
    elsif not v_current.active then
      update public.notification_signal_state
      set source_type = p_source_type,
          host_id = p_host_id,
          server_id = p_server_id,
          entity_type = p_entity_type,
          entity_key = p_entity_key,
          entity_name = p_entity_name,
          signal_type = p_signal_type,
          severity = p_severity,
          active = true,
          opened_at = p_occurred_at,
          last_seen_at = p_occurred_at,
          recovered_at = null,
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;
      v_transition := 'opened';
    elsif public.notification_severity_rank_v1(p_severity) > public.notification_severity_rank_v1(v_current.severity) then
      update public.notification_signal_state
      set severity = p_severity,
          last_seen_at = p_occurred_at,
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;
      v_transition := 'escalated';
    else
      update public.notification_signal_state
      set last_seen_at = p_occurred_at,
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;

      -- Catch-up: the episode was tracked silently and notifications
      -- are allowed again, so announce it once as an opened carrying
      -- the signal's current severity.
      if p_notify and not v_announced then
        v_transition := 'opened';
        v_delivery_severity := v_current.severity;
        v_title := case
          when v_current.severity = 'critical' then '重大化: ' || p_title
          else p_title
        end;
        v_dedupe_key := p_signal_key || ':opened:' || to_char(p_occurred_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');
        perform public.enqueue_notification_v1(
          v_dedupe_key, p_signal_key, p_source_type, p_host_id, p_server_id,
          p_entity_type, p_entity_key, p_entity_name, v_transition,
          v_delivery_severity, v_title, p_reason, p_detail_href, p_occurred_at
        );
      end if;

      return 'unchanged';
    end if;

    v_delivery_severity := p_severity;
    v_title := case when v_transition = 'escalated' then '重大化: ' || p_title else p_title end;

    if not p_notify then
      return v_transition;
    end if;
  else
    if not found or not v_current.active then
      return 'unchanged';
    end if;

    -- 復旧したSignalの未配送Open/Escalationを先に無効化する。
    -- Retry Backoff中の古いCriticalがRecovery後に配送されることを防ぐ。
    update public.notification_outbox
    set status = 'suppressed',
        suppression_reason = 'signal_recovered_before_delivery',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where signal_key = p_signal_key
      and transition in ('opened', 'escalated')
      and occurred_at >= v_current.opened_at
      and status in ('pending', 'retry', 'sending');

    update public.notification_signal_state
    set active = false,
        last_seen_at = p_occurred_at,
        recovered_at = greatest(opened_at, p_occurred_at),
        reason = p_reason,
        detail_href = p_detail_href,
        updated_at = clock_timestamp()
    where signal_key = p_signal_key;

    v_transition := 'recovered';
    v_delivery_severity := 'recovery';
    v_title := '復旧: ' || p_title;

    -- An episode that was never announced recovers silently too.
    if not v_announced then
      return v_transition;
    end if;
  end if;

  v_dedupe_key := p_signal_key || ':' || v_transition || ':' || to_char(p_occurred_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');

  perform public.enqueue_notification_v1(
    v_dedupe_key,
    p_signal_key,
    p_source_type,
    p_host_id,
    p_server_id,
    p_entity_type,
    p_entity_key,
    p_entity_name,
    v_transition,
    v_delivery_severity,
    v_title,
    p_reason,
    p_detail_href,
    p_occurred_at
  );

  return v_transition;
end;
$$;

-- v1 keeps its signature and always notifies (previous behaviour).
create or replace function public.apply_notification_signal_v1(
  p_signal_key text,
  p_source_type text,
  p_host_id uuid,
  p_server_id text,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_signal_type text,
  p_active boolean,
  p_severity text,
  p_occurred_at timestamptz,
  p_reason text,
  p_title text,
  p_detail_href text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return public.apply_notification_signal_v2(
    p_signal_key, p_source_type, p_host_id, p_server_id, p_entity_type,
    p_entity_key, p_entity_name, p_signal_type, p_active, p_severity,
    p_occurred_at, p_reason, p_title, p_detail_href, true
  );
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function public.apply_notification_signal_v2(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text, boolean) from public, anon, authenticated';
    execute 'grant execute on function public.apply_notification_signal_v2(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text, boolean) to service_role';
  end if;
end;
$$;

-- Scheduled reconcile: heartbeat signals go through v2 with the
-- console-disabled flag; backup signals keep the v1 behaviour.
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

    if v_age_seconds > 45 then
      perform public.apply_notification_signal_v2(
        'host:' || v_host.host_id::text || ':heartbeat',
        'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
        'heartbeat', true, 'warning', v_host.received_at + interval '45 seconds',
        'Heartbeatが45秒以上更新されていません',
        v_host.display_name || ' / Heartbeat', v_detail_href, not v_console_disabled
      );
      v_count := v_count + 1;

      if v_age_seconds > 180 then
        perform public.apply_notification_signal_v2(
          'host:' || v_host.host_id::text || ':heartbeat',
          'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
          'heartbeat', true, 'critical', v_host.received_at + interval '180 seconds',
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
