-- Issue #221: point-grant liveness monitoring. A new Signal source
-- (points) on the existing notification base, fed by a periodic checker
-- that counts today's (JST) login-bonus claims and point earn
-- transactions in the ivrm_api database through a read-only role.
--
-- Background: on 2026-11-13 the Points v3 tables had no GRANT for the
-- API runtime role, every point grant failed for a full day
-- (login_bonus_claims 0, point_transactions earn 0, 61 permission-denied
-- errors in the PG log), and no monitor noticed until a user reported
-- it the next morning. On a normal day claims start right after the
-- 09:00 JST notification, so "still zero at noon" is a strong signal.
--
-- Design (see Issue #221):
--   * The checker (deploy/systemd/ivrm-dash-points-check.sh, every
--     10 minutes) records one observation row per run through
--     record_point_grant_observation_v1(). When ivrm_api is not
--     configured or unreachable it records a non-ok status with NO
--     counts, so the liveness signal is never judged on missing data
--     (fail-safe against false alerts).
--   * reconcile_point_grant_signals_v1() runs every minute from
--     ivrm-dash-minutely and evaluates the latest ok observation
--     against the thresholds in point_grant_monitor_config (DB-side
--     settings, not code constants):
--       claims = 0 at claims_warn_at (12:00 JST)      -> warning
--       claims = 0 at claims_critical_at (15:00 JST) -> critical
--       earn   = 0 at earn_critical_at (12:00 JST)   -> critical
--     Recovery is automatic once counts are non-zero again.
--   * Self-monitoring: if no ok observation arrives within
--     stale_after_seconds, the points:grant-monitor-stale signal opens
--     (warning), so a dead checker is itself detected.
--   * Delivery reuses notification_outbox and the dispatch worker;
--     mentions follow the existing policy (opened x critical and
--     escalations mention, handled by the dispatcher).
--
-- Production application notes / remaining gates:
--   * Apply this migration as the owner role ivrm_dashboard_owner
--     (the standing rule for ivrm_dashboard migrations).
--   * This migration does NOT enable the monitor:
--     point_grant_monitor_config.enabled defaults to false.
--   * The ivrm_api read-only role is a separate, approval-gated step
--     (deploy/points-monitor/ivrm_api_readonly_role.sql). Until the
--     checker can read ivrm_api it records 'unconfigured' /
--     'unreachable' observations and nothing can fire.

-- 1. Allow the 'points' source/entity on the notification base, with
--    the same singleton shape as 'reliability' and 'cloud'
--    (host_id null, server_id 'ivrm', entity_type = source_type).
alter table public.notification_signal_state drop constraint notification_signal_source_check;
alter table public.notification_signal_state add constraint notification_signal_source_check check (source_type in ('host','container','backup','reliability','cloud','points'));
alter table public.notification_signal_state drop constraint notification_signal_entity_type_check;
alter table public.notification_signal_state add constraint notification_signal_entity_type_check check (entity_type in ('host','container','backup','reliability','cloud','points'));
alter table public.notification_signal_state drop constraint notification_signal_reliability_shape_check;
alter table public.notification_signal_state add constraint notification_signal_reliability_shape_check check ((source_type in ('reliability','cloud','points') and entity_type = source_type and host_id is null and server_id = 'ivrm') or (source_type in ('host','container','backup') and entity_type in ('host','container','backup') and host_id is not null));
alter table public.notification_outbox drop constraint notification_outbox_source_check;
alter table public.notification_outbox add constraint notification_outbox_source_check check (source_type in ('host','container','backup','reliability','cloud','points'));
alter table public.notification_outbox drop constraint notification_outbox_entity_type_check;
alter table public.notification_outbox add constraint notification_outbox_entity_type_check check (entity_type in ('host','container','backup','reliability','cloud','points'));
alter table public.notification_outbox drop constraint notification_outbox_reliability_shape_check;
alter table public.notification_outbox add constraint notification_outbox_reliability_shape_check check ((source_type in ('reliability','cloud','points') and entity_type = source_type and host_id is null and server_id = 'ivrm') or (source_type in ('host','container','backup') and entity_type in ('host','container','backup') and host_id is not null));
alter table public.notification_suppressions drop constraint notification_suppressions_scope_check;
alter table public.notification_suppressions add constraint notification_suppressions_scope_check check (scope_type in ('global','host','container','backup','reliability','cloud','points','signal'));

-- 2. Monitor configuration (singleton). Thresholds live here so they
--    can be tuned without a code change. The monitor ships disabled.
create table public.point_grant_monitor_config (
  id smallint primary key check (id = 1),
  enabled boolean not null default false,
  claims_warn_at time not null default time '12:00',
  claims_critical_at time not null default time '15:00',
  earn_critical_at time not null default time '12:00',
  stale_after_seconds integer not null default 2700 check (stale_after_seconds between 300 and 86400),
  updated_at timestamptz not null default clock_timestamp(),
  constraint point_grant_monitor_config_threshold_order_check check (claims_warn_at < claims_critical_at)
);
insert into public.point_grant_monitor_config (id) values (1);
alter table public.point_grant_monitor_config enable row level security;
revoke all on public.point_grant_monitor_config from public, anon, authenticated;
grant select on public.point_grant_monitor_config to service_role;

-- 3. Observations: one row per checker run. This is also the checker
--    heartbeat: the newest rows tell the reconcile whether the checker
--    is alive and whether it can actually measure ivrm_api.
create table public.point_grant_observations (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null,
  day_jst date not null,
  source_status text not null check (source_status in ('ok', 'unconfigured', 'unreachable', 'error')),
  claims_count integer,
  earn_count integer,
  xp_events_count integer,
  detail text check (detail is null or char_length(detail) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  constraint point_grant_observations_counts_check check (
    (source_status = 'ok' and claims_count is not null and earn_count is not null)
    or (source_status <> 'ok' and claims_count is null and earn_count is null and xp_events_count is null)
  ),
  constraint point_grant_observations_nonnegative_check check (
    (claims_count is null or claims_count >= 0)
    and (earn_count is null or earn_count >= 0)
    and (xp_events_count is null or xp_events_count >= 0)
  )
);
create index point_grant_observations_checked on public.point_grant_observations (checked_at desc, id desc);
alter table public.point_grant_observations enable row level security;
revoke all on public.point_grant_observations from public, anon, authenticated;
grant select on public.point_grant_observations to service_role;

create or replace function public.record_point_grant_observation_v1(
  p_source_status text,
  p_claims_count integer,
  p_earn_count integer,
  p_xp_events_count integer,
  p_detail text,
  p_checked_at timestamptz default clock_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id bigint;
begin
  if p_source_status is null
    or p_source_status not in ('ok', 'unconfigured', 'unreachable', 'error')
    or p_checked_at is null
    or (p_detail is not null and char_length(p_detail) not between 1 and 200)
    or (p_source_status = 'ok' and (p_claims_count is null or p_claims_count < 0
        or p_earn_count is null or p_earn_count < 0
        or (p_xp_events_count is not null and p_xp_events_count < 0)))
    or (p_source_status <> 'ok' and (p_claims_count is not null
        or p_earn_count is not null or p_xp_events_count is not null)) then
    raise exception 'point_grant_observation_invalid' using errcode = '22023';
  end if;

  insert into public.point_grant_observations (
    checked_at, day_jst, source_status, claims_count, earn_count,
    xp_events_count, detail
  ) values (
    p_checked_at,
    (p_checked_at at time zone 'Asia/Tokyo')::date,
    p_source_status, p_claims_count, p_earn_count, p_xp_events_count, p_detail
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.record_point_grant_observation_v1(text, integer, integer, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_point_grant_observation_v1(text, integer, integer, integer, text, timestamptz) to service_role;

-- 4. Outbox enqueue for the points source (mirrors
--    enqueue_cloud_notification_v1; the console has no points page,
--    so the detail href is fixed to the console root).
create or replace function public.enqueue_point_notification_v1(
  p_dedupe_key text,
  p_signal_key text,
  p_source_type text,
  p_host_id uuid,
  p_server_id text,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_transition text,
  p_severity text,
  p_title text,
  p_message text,
  p_detail_href text,
  p_occurred_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_suppression_reason text;
  v_status text;
  v_id bigint;
begin
  if p_dedupe_key is null or char_length(p_dedupe_key) not between 1 and 700
    or p_source_type not in ('points')
    or p_host_id is not null
    or p_server_id is distinct from 'ivrm'
    or p_entity_type not in ('points')
    or p_entity_key is null or char_length(p_entity_key) not between 1 and 400
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_transition not in ('opened', 'escalated', 'recovered', 'event')
    or p_severity not in ('info', 'warning', 'critical', 'recovery')
    or p_title is null or char_length(p_title) not between 1 and 160
    or p_message is null or char_length(p_message) not between 1 and 1800
    or p_detail_href is null or p_detail_href <> '/'
    or p_occurred_at is null then
    raise exception 'notification_payload_invalid' using errcode = '22023';
  end if;

  v_suppression_reason := public.notification_suppression_reason_v1(
    p_host_id,
    p_entity_type,
    p_entity_key,
    p_entity_name,
    coalesce(p_signal_key, p_dedupe_key),
    p_occurred_at
  );
  v_status := case when v_suppression_reason is null then 'pending' else 'suppressed' end;

  insert into public.notification_outbox (
    dedupe_key, signal_key, source_type, host_id, server_id, entity_type,
    entity_key, entity_name, transition, severity, title, message,
    detail_href, occurred_at, status, suppression_reason
  ) values (
    p_dedupe_key, p_signal_key, p_source_type, p_host_id, p_server_id,
    p_entity_type, p_entity_key, p_entity_name, p_transition, p_severity,
    p_title, p_message, p_detail_href, p_occurred_at, v_status,
    v_suppression_reason
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select outbox.id into v_id
    from public.notification_outbox as outbox
    where outbox.dedupe_key = p_dedupe_key;
  end if;

  return v_id;
end;
$$;
revoke all on function public.enqueue_point_notification_v1(text, text, text, uuid, text, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;

-- 5. Signal state machine for the points source (same transitions as
--    the cloud v2 machine, minus the silent-open mode: point signals
--    are only ever applied with notification intent).
create or replace function public.apply_point_grant_signal_v1(
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
declare
  v_current public.notification_signal_state%rowtype;
  v_transition text;
  v_dedupe_key text;
  v_delivery_severity text;
  v_title text;
begin
  if p_signal_key is null or char_length(p_signal_key) not between 1 and 500
    or p_source_type is null or p_source_type not in ('points')
    or p_host_id is not null
    or p_server_id is distinct from 'ivrm'
    or p_entity_type is null or p_entity_type not in ('points')
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
    or p_detail_href !~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$' then
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
      return 'unchanged';
    end if;

    v_delivery_severity := p_severity;
    v_title := case when v_transition = 'escalated' then '重大化: ' || p_title else p_title end;
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
  end if;

  v_dedupe_key := p_signal_key || ':' || v_transition || ':' || to_char(p_occurred_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');

  perform public.enqueue_point_notification_v1(
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
revoke all on function public.apply_point_grant_signal_v1(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text) from public, anon, authenticated;

-- 6. Evaluation: pure decision over (config, observations, now).
--    The clock is a parameter so boundary behaviour is testable.
--    status:
--      disabled  - monitor not enabled; nothing may fire.
--      unknown   - no fresh ok observation for today (JST); the grant
--                  signal must not be judged (fail-safe).
--      ok        - counts are non-zero, or thresholds not reached yet.
--      warning   - claims still 0 at/after claims_warn_at.
--      critical  - earn still 0 at/after earn_critical_at, or claims
--                  still 0 at/after claims_critical_at.
--    monitor_stale is reported independently: true when no ok
--    observation arrived within stale_after_seconds.
create or replace function public.evaluate_point_grant_liveness_v1(
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_config public.point_grant_monitor_config%rowtype;
  v_latest_any public.point_grant_observations%rowtype;
  v_latest_ok public.point_grant_observations%rowtype;
  v_found_any boolean;
  v_found_ok boolean;
  v_day date;
  v_time time;
  v_ok_age_seconds double precision;
  v_status text;
  v_severity text;
  v_reason_code text;
begin
  if p_now is null then
    raise exception 'point_grant_evaluation_invalid' using errcode = '22023';
  end if;

  v_day := (p_now at time zone 'Asia/Tokyo')::date;
  v_time := (p_now at time zone 'Asia/Tokyo')::time;

  select * into v_config from public.point_grant_monitor_config where id = 1;
  if not found or not v_config.enabled then
    return jsonb_build_object(
      'status', 'disabled',
      'severity', null,
      'reason_code', null,
      'monitor_stale', false,
      'day_jst', v_day
    );
  end if;

  select * into v_latest_any
  from public.point_grant_observations
  order by checked_at desc, id desc
  limit 1;
  v_found_any := found;

  select * into v_latest_ok
  from public.point_grant_observations
  where source_status = 'ok'
  order by checked_at desc, id desc
  limit 1;
  v_found_ok := found;

  v_ok_age_seconds := case when v_found_ok
    then extract(epoch from (p_now - v_latest_ok.checked_at))
    else null end;

  if not v_found_ok
    or v_latest_ok.day_jst <> v_day
    or v_ok_age_seconds > v_config.stale_after_seconds
    or v_ok_age_seconds < -300 then
    v_status := 'unknown';
    v_severity := null;
    v_reason_code := null;
  elsif v_latest_ok.earn_count = 0 and v_time >= v_config.earn_critical_at then
    v_status := 'critical';
    v_severity := 'critical';
    v_reason_code := 'earn_zero';
  elsif v_latest_ok.claims_count = 0 and v_time >= v_config.claims_critical_at then
    v_status := 'critical';
    v_severity := 'critical';
    v_reason_code := 'claims_zero_critical';
  elsif v_latest_ok.claims_count = 0 and v_time >= v_config.claims_warn_at then
    v_status := 'warning';
    v_severity := 'warning';
    v_reason_code := 'claims_zero_warn';
  else
    v_status := 'ok';
    v_severity := null;
    v_reason_code := null;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'severity', v_severity,
    'reason_code', v_reason_code,
    'monitor_stale', (
      not v_found_ok
      or v_ok_age_seconds > v_config.stale_after_seconds
      or v_ok_age_seconds < -300
    ),
    'day_jst', v_day,
    'claims_count', case when v_found_ok then v_latest_ok.claims_count else null end,
    'earn_count', case when v_found_ok then v_latest_ok.earn_count else null end,
    'xp_events_count', case when v_found_ok then v_latest_ok.xp_events_count else null end,
    'last_ok_checked_at', case when v_found_ok then v_latest_ok.checked_at else null end,
    'last_any_status', case when v_found_any then v_latest_any.source_status else null end,
    'last_any_checked_at', case when v_found_any then v_latest_any.checked_at else null end,
    'stale_after_seconds', v_config.stale_after_seconds
  );
end;
$$;
revoke all on function public.evaluate_point_grant_liveness_v1(timestamptz) from public, anon, authenticated;
grant execute on function public.evaluate_point_grant_liveness_v1(timestamptz) to service_role;

-- 7. Reconcile: apply the evaluation to the two point signals. Runs
--    every minute from ivrm-dash-minutely; the optional clock exists
--    for tests.
create or replace function public.reconcile_point_grant_signals_v1(
  p_now timestamptz default clock_timestamp()
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_eval jsonb;
  v_status text;
  v_reason text;
  v_counts_text text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ivrm-point-grant-monitor', 0));

  v_eval := public.evaluate_point_grant_liveness_v1(p_now);
  v_status := v_eval ->> 'status';

  if v_status = 'disabled' then
    return 'disabled';
  end if;

  v_counts_text := 'claims ' || coalesce(v_eval ->> 'claims_count', '-')
    || ' 件 / earn ' || coalesce(v_eval ->> 'earn_count', '-')
    || ' 件 / XP着信 ' || coalesce(v_eval ->> 'xp_events_count', '-')
    || ' 件 (最終正常観測 '
    || coalesce(to_char((v_eval ->> 'last_ok_checked_at')::timestamptz at time zone 'Asia/Tokyo', 'MM-DD HH24:MI'), 'なし')
    || ')';

  -- Self-monitoring first: a stale checker means grants cannot be
  -- judged at all, which is itself worth one warning signal.
  if (v_eval ->> 'monitor_stale')::boolean then
    perform public.apply_point_grant_signal_v1(
      'points:grant-monitor-stale', 'points', null, 'ivrm', 'points',
      'point-grant-checker', 'ポイント付与チェッカー', 'point_grant_monitor_stale',
      true, 'warning', p_now,
      'point_grant_monitor_stale: ポイント付与チェッカーの正常な観測が '
        || (v_eval ->> 'stale_after_seconds')
        || ' 秒以上途絶えています (最終観測: '
        || coalesce(v_eval ->> 'last_any_status', 'なし') || ' / '
        || coalesce(to_char((v_eval ->> 'last_any_checked_at')::timestamptz at time zone 'Asia/Tokyo', 'MM-DD HH24:MI'), 'なし')
        || ')。監視が機能していないため、ポイント付与の障害を検知できない状態です。',
      'ポイント付与監視 / チェック停止', '/');
  else
    perform public.apply_point_grant_signal_v1(
      'points:grant-monitor-stale', 'points', null, 'ivrm', 'points',
      'point-grant-checker', 'ポイント付与チェッカー', 'point_grant_monitor_stale',
      false, 'warning', p_now,
      'point_grant_monitor_recovered: ポイント付与チェッカーの観測が再開しました (' || v_counts_text || ')。',
      'ポイント付与監視 / チェック停止', '/');
  end if;

  -- Grant liveness. 'unknown' deliberately leaves the signal untouched:
  -- missing data must neither open nor close an alert.
  if v_status in ('warning', 'critical') then
    v_reason := case v_eval ->> 'reason_code'
      when 'earn_zero' then
        'point_grant_earn_zero: 本日 (JST) のポイント付与 (earn) が 0 件のまま閾値時刻を過ぎました (' || v_counts_text || ')。2026-11-13 の全件失敗と同型のパターンです。'
      when 'claims_zero_critical' then
        'point_grant_claims_zero: 本日 (JST) のログインボーナス受取が 0 件のまま 15:00 を過ぎました (' || v_counts_text || ')。'
      else
        'point_grant_claims_zero: 本日 (JST) のログインボーナス受取が 0 件のまま 12:00 を過ぎました (' || v_counts_text || ')。ポイント付与経路の障害の可能性があります。'
    end;
    perform public.apply_point_grant_signal_v1(
      'points:grant-liveness', 'points', null, 'ivrm', 'points',
      'point-grants', 'ポイント付与', 'point_grant_liveness',
      true, v_eval ->> 'severity', p_now, v_reason,
      'ポイント付与 / 死活監視', '/');
  elsif v_status = 'ok' then
    perform public.apply_point_grant_signal_v1(
      'points:grant-liveness', 'points', null, 'ivrm', 'points',
      'point-grants', 'ポイント付与', 'point_grant_liveness',
      false, 'warning', p_now,
      'point_grant_recovered: ポイント付与は正常です (' || v_counts_text || ')。',
      'ポイント付与 / 死活監視', '/');
  end if;

  return v_status;
end;
$$;
revoke all on function public.reconcile_point_grant_signals_v1(timestamptz) from public, anon, authenticated;
grant execute on function public.reconcile_point_grant_signals_v1(timestamptz) to service_role;

-- 8. Retention for observations (7 days, mirroring cloud samples).
create or replace function public.prune_point_grant_observations_v1()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.point_grant_observations
  where checked_at < clock_timestamp() - interval '7 days';
end;
$$;
revoke all on function public.prune_point_grant_observations_v1() from public, anon, authenticated;
grant execute on function public.prune_point_grant_observations_v1() to service_role;
