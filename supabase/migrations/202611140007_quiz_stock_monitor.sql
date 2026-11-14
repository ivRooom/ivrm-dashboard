-- Issue ivrm-web#749: quiz stock-out / next-day-missing detection and
-- admin notification. A new Signal source (quiz) on the existing
-- notification base, fed by a periodic checker that reads the quiz
-- stock in the ivrm_api database through the existing read-only role
-- (ivrm_dashboard_points_ro, extended by the approval-gated grants in
-- deploy/quiz-monitor/ivrm_api_quiz_readonly_grants.sql).
--
-- Background: on 2026-11-01 the V1 publication for the day was fixed
-- to quiz_id = 'none' because no approved candidate existed, and the
-- outage was only noticed after the slot had started. The Admin
-- outlook (ivrm-web PR-F) shows the stock, but nothing watched it.
-- This monitor judges, with SELECT-only preflight reads (the
-- publication materializer is never called):
--   * V2 (daily_questions, date-fixed model): ready rows
--     (status in ('approved','published')) for the current slot day
--     and the next slot day, draft rows for the next day, and the
--     runway of consecutive ready days starting at the next day.
--   * V1 (daily_login_quizzes / daily_login_quiz_publications):
--     whether today's publication is already fixed to 'none', and
--     the selectDailyQuiz candidate count for the next slot day.
--
-- Design (see ivrm-web Issue #749):
--   * The checker (deploy/systemd/ivrm-dash-quiz-check.sh, every
--     10 minutes) records one observation row per run through
--     record_quiz_stock_observation_v1(). When ivrm_api is not
--     configured or unreachable it records a non-ok status with NO
--     counts, so stock is never judged on missing data (fail-safe).
--   * reconcile_quiz_stock_signals_v1() runs every minute from
--     ivrm-dash-minutely and evaluates the latest ok observation
--     against the thresholds in quiz_stock_monitor_config (DB-side
--     settings, not code constants):
--       V2 today ready = 0                          -> critical
--       V2 next ready = 0 at warn_at (12:00 JST)    -> warning
--       V2 next ready = 0 at critical_at (21:00)    -> critical
--       V1 publication fixed to 'none' today        -> critical
--       V1 next candidates = 0 at warn_at/critical_at -> warning/critical
--       V2 runway <= runway_warn_days (2) at warn_at -> warning
--     Recovery is automatic once stock is back.
--   * Self-monitoring: if no ok observation arrives within
--     stale_after_seconds, the quiz:stock-monitor-stale signal opens
--     (warning), so a dead checker is itself detected.
--   * v1_enabled / v2_enabled let operations silence a stream that
--     was intentionally stopped (the API-side flags are not visible
--     from the database).
--   * Delivery reuses notification_outbox and the dispatch worker;
--     mentions follow the existing policy (opened x critical and
--     escalations mention, handled by the dispatcher).
--
-- Production application notes / remaining gates:
--   * Apply this migration as the owner role ivrm_dashboard_owner
--     (the standing rule for ivrm_dashboard migrations).
--   * This migration does NOT enable the monitor:
--     quiz_stock_monitor_config.enabled defaults to false.
--   * The ivrm_api read-only grants for the quiz tables are a
--     separate, approval-gated step
--     (deploy/quiz-monitor/ivrm_api_quiz_readonly_grants.sql). Until
--     they are applied the checker records 'unreachable' observations
--     and nothing can fire.

-- 1. Allow the 'quiz' source/entity on the notification base, with
--    the same singleton shape as 'points' (host_id null, server_id
--    'ivrm', entity_type = source_type).
alter table public.notification_signal_state drop constraint notification_signal_source_check;
alter table public.notification_signal_state add constraint notification_signal_source_check check (source_type in ('host','container','backup','reliability','cloud','points','quiz'));
alter table public.notification_signal_state drop constraint notification_signal_entity_type_check;
alter table public.notification_signal_state add constraint notification_signal_entity_type_check check (entity_type in ('host','container','backup','reliability','cloud','points','quiz'));
alter table public.notification_signal_state drop constraint notification_signal_reliability_shape_check;
alter table public.notification_signal_state add constraint notification_signal_reliability_shape_check check ((source_type in ('reliability','cloud','points','quiz') and entity_type = source_type and host_id is null and server_id = 'ivrm') or (source_type in ('host','container','backup') and entity_type in ('host','container','backup') and host_id is not null));
alter table public.notification_outbox drop constraint notification_outbox_source_check;
alter table public.notification_outbox add constraint notification_outbox_source_check check (source_type in ('host','container','backup','reliability','cloud','points','quiz'));
alter table public.notification_outbox drop constraint notification_outbox_entity_type_check;
alter table public.notification_outbox add constraint notification_outbox_entity_type_check check (entity_type in ('host','container','backup','reliability','cloud','points','quiz'));
alter table public.notification_outbox drop constraint notification_outbox_reliability_shape_check;
alter table public.notification_outbox add constraint notification_outbox_reliability_shape_check check ((source_type in ('reliability','cloud','points','quiz') and entity_type = source_type and host_id is null and server_id = 'ivrm') or (source_type in ('host','container','backup') and entity_type in ('host','container','backup') and host_id is not null));
alter table public.notification_suppressions drop constraint notification_suppressions_scope_check;
alter table public.notification_suppressions add constraint notification_suppressions_scope_check check (scope_type in ('global','host','container','backup','reliability','cloud','points','quiz','signal'));

-- 2. Monitor configuration (singleton). Thresholds live here so they
--    can be tuned without a code change. The monitor ships disabled.
create table public.quiz_stock_monitor_config (
  id smallint primary key check (id = 1),
  enabled boolean not null default false,
  v1_enabled boolean not null default true,
  v2_enabled boolean not null default true,
  warn_at time not null default time '12:00',
  critical_at time not null default time '21:00',
  runway_warn_days integer not null default 2 check (runway_warn_days between 0 and 14),
  stale_after_seconds integer not null default 2700 check (stale_after_seconds between 300 and 86400),
  updated_at timestamptz not null default clock_timestamp(),
  constraint quiz_stock_monitor_config_threshold_order_check check (warn_at < critical_at)
);
insert into public.quiz_stock_monitor_config (id) values (1);
alter table public.quiz_stock_monitor_config enable row level security;
revoke all on public.quiz_stock_monitor_config from public, anon, authenticated;
grant select on public.quiz_stock_monitor_config to service_role;

-- 3. Observations: one row per checker run. An ok row carries the
--    preflight counts for the slot day it was taken in (slot_day_jst)
--    and the next slot day (target_day_jst = slot_day_jst + 1). This
--    is also the checker heartbeat: the newest rows tell the
--    reconcile whether the checker is alive and whether it can
--    actually measure ivrm_api.
create table public.quiz_stock_observations (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null,
  slot_day_jst date,
  target_day_jst date,
  source_status text not null check (source_status in ('ok', 'unconfigured', 'unreachable', 'error')),
  v2_today_ready integer,
  v2_today_draft integer,
  v2_next_ready integer,
  v2_next_draft integer,
  v2_next_bonus_ready integer,
  v2_runway_days integer,
  v1_today_none_confirmed boolean,
  v1_next_candidates integer,
  v1_next_fixed integer,
  v1_pool integer,
  detail text check (detail is null or char_length(detail) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  constraint quiz_stock_observations_counts_check check (
    (source_status = 'ok'
      and slot_day_jst is not null and target_day_jst is not null
      and v2_today_ready is not null and v2_today_draft is not null
      and v2_next_ready is not null and v2_next_draft is not null
      and v2_next_bonus_ready is not null and v2_runway_days is not null
      and v1_today_none_confirmed is not null
      and v1_next_candidates is not null and v1_next_fixed is not null
      and v1_pool is not null)
    or (source_status <> 'ok'
      and slot_day_jst is null and target_day_jst is null
      and v2_today_ready is null and v2_today_draft is null
      and v2_next_ready is null and v2_next_draft is null
      and v2_next_bonus_ready is null and v2_runway_days is null
      and v1_today_none_confirmed is null
      and v1_next_candidates is null and v1_next_fixed is null
      and v1_pool is null)
  ),
  constraint quiz_stock_observations_nonnegative_check check (
    (v2_today_ready is null or v2_today_ready >= 0)
    and (v2_today_draft is null or v2_today_draft >= 0)
    and (v2_next_ready is null or v2_next_ready >= 0)
    and (v2_next_draft is null or v2_next_draft >= 0)
    and (v2_next_bonus_ready is null or v2_next_bonus_ready >= 0)
    and (v2_runway_days is null or v2_runway_days between 0 and 14)
    and (v1_next_candidates is null or v1_next_candidates >= 0)
    and (v1_next_fixed is null or v1_next_fixed >= 0)
    and (v1_pool is null or v1_pool >= 0)
  )
);
create index quiz_stock_observations_checked on public.quiz_stock_observations (checked_at desc, id desc);
alter table public.quiz_stock_observations enable row level security;
revoke all on public.quiz_stock_observations from public, anon, authenticated;
grant select on public.quiz_stock_observations to service_role;

create or replace function public.record_quiz_stock_observation_v1(
  p_source_status text,
  p_slot_day_jst date,
  p_target_day_jst date,
  p_v2_today_ready integer,
  p_v2_today_draft integer,
  p_v2_next_ready integer,
  p_v2_next_draft integer,
  p_v2_next_bonus_ready integer,
  p_v2_runway_days integer,
  p_v1_today_none_confirmed boolean,
  p_v1_next_candidates integer,
  p_v1_next_fixed integer,
  p_v1_pool integer,
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
    or (p_source_status = 'ok' and (
        p_slot_day_jst is null or p_target_day_jst is null
        or p_target_day_jst <> p_slot_day_jst + 1
        or p_v2_today_ready is null or p_v2_today_ready < 0
        or p_v2_today_draft is null or p_v2_today_draft < 0
        or p_v2_next_ready is null or p_v2_next_ready < 0
        or p_v2_next_draft is null or p_v2_next_draft < 0
        or p_v2_next_bonus_ready is null or p_v2_next_bonus_ready < 0
        or p_v2_runway_days is null or p_v2_runway_days not between 0 and 14
        or p_v1_today_none_confirmed is null
        or p_v1_next_candidates is null or p_v1_next_candidates < 0
        or p_v1_next_fixed is null or p_v1_next_fixed < 0
        or p_v1_pool is null or p_v1_pool < 0))
    or (p_source_status <> 'ok' and (
        p_slot_day_jst is not null or p_target_day_jst is not null
        or p_v2_today_ready is not null or p_v2_today_draft is not null
        or p_v2_next_ready is not null or p_v2_next_draft is not null
        or p_v2_next_bonus_ready is not null or p_v2_runway_days is not null
        or p_v1_today_none_confirmed is not null
        or p_v1_next_candidates is not null or p_v1_next_fixed is not null
        or p_v1_pool is not null)) then
    raise exception 'quiz_stock_observation_invalid' using errcode = '22023';
  end if;

  insert into public.quiz_stock_observations (
    checked_at, slot_day_jst, target_day_jst, source_status,
    v2_today_ready, v2_today_draft, v2_next_ready, v2_next_draft,
    v2_next_bonus_ready, v2_runway_days, v1_today_none_confirmed,
    v1_next_candidates, v1_next_fixed, v1_pool, detail
  ) values (
    p_checked_at, p_slot_day_jst, p_target_day_jst, p_source_status,
    p_v2_today_ready, p_v2_today_draft, p_v2_next_ready, p_v2_next_draft,
    p_v2_next_bonus_ready, p_v2_runway_days, p_v1_today_none_confirmed,
    p_v1_next_candidates, p_v1_next_fixed, p_v1_pool, p_detail
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function public.record_quiz_stock_observation_v1(text, date, date, integer, integer, integer, integer, integer, integer, boolean, integer, integer, integer, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_quiz_stock_observation_v1(text, date, date, integer, integer, integer, integer, integer, integer, boolean, integer, integer, integer, text, timestamptz) to service_role;

-- 4. Outbox enqueue for the quiz source (mirrors
--    enqueue_point_notification_v1; the console has no quiz page, so
--    the detail href is fixed to the console root).
create or replace function public.enqueue_quiz_notification_v1(
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
    or p_source_type not in ('quiz')
    or p_host_id is not null
    or p_server_id is distinct from 'ivrm'
    or p_entity_type not in ('quiz')
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
revoke all on function public.enqueue_quiz_notification_v1(text, text, text, uuid, text, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;

-- 5. Signal state machine for the quiz source (same transitions as
--    the points machine: quiz signals are only ever applied with
--    notification intent).
create or replace function public.apply_quiz_stock_signal_v1(
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
    or p_source_type is null or p_source_type not in ('quiz')
    or p_host_id is not null
    or p_server_id is distinct from 'ivrm'
    or p_entity_type is null or p_entity_type not in ('quiz')
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

  perform public.enqueue_quiz_notification_v1(
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
revoke all on function public.apply_quiz_stock_signal_v1(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text) from public, anon, authenticated;

-- 6. Evaluation: pure decision over (config, observations, now).
--    The clock is a parameter so boundary behaviour is testable.
--    The slot day follows the API's dailySlotDate: JST, before
--    09:00 the running slot is still the previous calendar day.
--    Each section (v2 / v1 / runway) reports:
--      disabled - stream or monitor switched off; never judged.
--      unknown  - no fresh ok observation for the current slot day;
--                 the section must not be judged (fail-safe).
--      ok       - stock is present, or thresholds not reached yet.
--      warning / critical - per the thresholds above.
--    monitor_stale is reported independently: true when no ok
--    observation arrived within stale_after_seconds.
create or replace function public.evaluate_quiz_stock_v1(
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_config public.quiz_stock_monitor_config%rowtype;
  v_latest_any public.quiz_stock_observations%rowtype;
  v_latest_ok public.quiz_stock_observations%rowtype;
  v_found_any boolean;
  v_found_ok boolean;
  v_day date;
  v_time time;
  v_slot_day date;
  v_ok_age_seconds double precision;
  v_judgeable boolean;
  v_v2_status text;
  v_v2_severity text;
  v_v2_reason_code text;
  v_v1_status text;
  v_v1_severity text;
  v_v1_reason_code text;
  v_runway_status text;
  v_runway_severity text;
  v_runway_reason_code text;
begin
  if p_now is null then
    raise exception 'quiz_stock_evaluation_invalid' using errcode = '22023';
  end if;

  v_day := (p_now at time zone 'Asia/Tokyo')::date;
  v_time := (p_now at time zone 'Asia/Tokyo')::time;
  v_slot_day := case when v_time < time '09:00' then v_day - 1 else v_day end;

  select * into v_config from public.quiz_stock_monitor_config where id = 1;
  if not found or not v_config.enabled then
    return jsonb_build_object(
      'status', 'disabled',
      'monitor_stale', false,
      'slot_day_jst', v_slot_day,
      'target_day_jst', v_slot_day + 1,
      'v2', jsonb_build_object('status', 'disabled', 'severity', null, 'reason_code', null),
      'v1', jsonb_build_object('status', 'disabled', 'severity', null, 'reason_code', null),
      'runway', jsonb_build_object('status', 'disabled', 'severity', null, 'reason_code', null)
    );
  end if;

  select * into v_latest_any
  from public.quiz_stock_observations
  order by checked_at desc, id desc
  limit 1;
  v_found_any := found;

  select * into v_latest_ok
  from public.quiz_stock_observations
  where source_status = 'ok'
  order by checked_at desc, id desc
  limit 1;
  v_found_ok := found;

  v_ok_age_seconds := case when v_found_ok
    then extract(epoch from (p_now - v_latest_ok.checked_at))
    else null end;

  v_judgeable := v_found_ok
    and v_latest_ok.slot_day_jst = v_slot_day
    and v_ok_age_seconds <= v_config.stale_after_seconds
    and v_ok_age_seconds >= -300;

  -- V2 daily stock.
  if not v_config.v2_enabled then
    v_v2_status := 'disabled'; v_v2_severity := null; v_v2_reason_code := null;
  elsif not v_judgeable then
    v_v2_status := 'unknown'; v_v2_severity := null; v_v2_reason_code := null;
  elsif v_latest_ok.v2_today_ready = 0 then
    v_v2_status := 'critical'; v_v2_severity := 'critical'; v_v2_reason_code := 'v2_today_empty';
  elsif v_latest_ok.v2_next_ready = 0 and v_time >= v_config.critical_at then
    v_v2_status := 'critical'; v_v2_severity := 'critical'; v_v2_reason_code := 'v2_next_empty';
  elsif v_latest_ok.v2_next_ready = 0 and v_time >= v_config.warn_at then
    v_v2_status := 'warning'; v_v2_severity := 'warning'; v_v2_reason_code := 'v2_next_empty';
  else
    v_v2_status := 'ok'; v_v2_severity := null; v_v2_reason_code := null;
  end if;

  -- V1 login-bonus stock.
  if not v_config.v1_enabled then
    v_v1_status := 'disabled'; v_v1_severity := null; v_v1_reason_code := null;
  elsif not v_judgeable then
    v_v1_status := 'unknown'; v_v1_severity := null; v_v1_reason_code := null;
  elsif v_latest_ok.v1_today_none_confirmed then
    v_v1_status := 'critical'; v_v1_severity := 'critical'; v_v1_reason_code := 'v1_none_confirmed';
  elsif v_latest_ok.v1_next_candidates = 0 and v_time >= v_config.critical_at then
    v_v1_status := 'critical'; v_v1_severity := 'critical'; v_v1_reason_code := 'v1_next_empty';
  elsif v_latest_ok.v1_next_candidates = 0 and v_time >= v_config.warn_at then
    v_v1_status := 'warning'; v_v1_severity := 'warning'; v_v1_reason_code := 'v1_next_empty';
  else
    v_v1_status := 'ok'; v_v1_severity := null; v_v1_reason_code := null;
  end if;

  -- V2 runway. Only judged when the next day itself has stock: a
  -- missing next day belongs to the stock signal, not the runway.
  if not v_config.v2_enabled then
    v_runway_status := 'disabled'; v_runway_severity := null; v_runway_reason_code := null;
  elsif not v_judgeable then
    v_runway_status := 'unknown'; v_runway_severity := null; v_runway_reason_code := null;
  elsif v_latest_ok.v2_next_ready > 0
    and v_latest_ok.v2_runway_days <= v_config.runway_warn_days
    and v_time >= v_config.warn_at then
    v_runway_status := 'warning'; v_runway_severity := 'warning'; v_runway_reason_code := 'runway_low';
  else
    v_runway_status := 'ok'; v_runway_severity := null; v_runway_reason_code := null;
  end if;

  return jsonb_build_object(
    'status', case when v_judgeable then 'ok' else 'unknown' end,
    'monitor_stale', (
      not v_found_ok
      or v_ok_age_seconds > v_config.stale_after_seconds
      or v_ok_age_seconds < -300
    ),
    'slot_day_jst', v_slot_day,
    'target_day_jst', v_slot_day + 1,
    'v2', jsonb_build_object('status', v_v2_status, 'severity', v_v2_severity, 'reason_code', v_v2_reason_code),
    'v1', jsonb_build_object('status', v_v1_status, 'severity', v_v1_severity, 'reason_code', v_v1_reason_code),
    'runway', jsonb_build_object('status', v_runway_status, 'severity', v_runway_severity, 'reason_code', v_runway_reason_code),
    'v2_today_ready', case when v_found_ok then v_latest_ok.v2_today_ready else null end,
    'v2_today_draft', case when v_found_ok then v_latest_ok.v2_today_draft else null end,
    'v2_next_ready', case when v_found_ok then v_latest_ok.v2_next_ready else null end,
    'v2_next_draft', case when v_found_ok then v_latest_ok.v2_next_draft else null end,
    'v2_next_bonus_ready', case when v_found_ok then v_latest_ok.v2_next_bonus_ready else null end,
    'v2_runway_days', case when v_found_ok then v_latest_ok.v2_runway_days else null end,
    'v1_today_none_confirmed', case when v_found_ok then v_latest_ok.v1_today_none_confirmed else null end,
    'v1_next_candidates', case when v_found_ok then v_latest_ok.v1_next_candidates else null end,
    'v1_next_fixed', case when v_found_ok then v_latest_ok.v1_next_fixed else null end,
    'v1_pool', case when v_found_ok then v_latest_ok.v1_pool else null end,
    'last_ok_checked_at', case when v_found_ok then v_latest_ok.checked_at else null end,
    'last_any_status', case when v_found_any then v_latest_any.source_status else null end,
    'last_any_checked_at', case when v_found_any then v_latest_any.checked_at else null end,
    'stale_after_seconds', v_config.stale_after_seconds
  );
end;
$$;
revoke all on function public.evaluate_quiz_stock_v1(timestamptz) from public, anon, authenticated;
grant execute on function public.evaluate_quiz_stock_v1(timestamptz) to service_role;

-- 7. Reconcile: apply the evaluation to the four quiz signals. Runs
--    every minute from ivrm-dash-minutely; the optional clock exists
--    for tests. Returns the worst judged section ('disabled',
--    'unknown', 'ok', 'warning' or 'critical').
create or replace function public.reconcile_quiz_stock_signals_v1(
  p_now timestamptz default clock_timestamp()
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_eval jsonb;
  v_counts_text text;
  v_reason text;
  v_worst text := null;
begin
  perform pg_advisory_xact_lock(hashtextextended('ivrm-quiz-stock-monitor', 0));

  v_eval := public.evaluate_quiz_stock_v1(p_now);

  if v_eval ->> 'status' = 'disabled' then
    return 'disabled';
  end if;

  v_counts_text := '当日V2 ready ' || coalesce(v_eval ->> 'v2_today_ready', '-')
    || ' 件 (draft ' || coalesce(v_eval ->> 'v2_today_draft', '-') || ' 件)'
    || ' / 翌日V2 ready ' || coalesce(v_eval ->> 'v2_next_ready', '-')
    || ' 件 (draft ' || coalesce(v_eval ->> 'v2_next_draft', '-')
    || ' 件, bonus ready ' || coalesce(v_eval ->> 'v2_next_bonus_ready', '-') || ' 件)'
    || ' / runway ' || coalesce(v_eval ->> 'v2_runway_days', '-') || ' 日'
    || ' / V1翌日候補 ' || coalesce(v_eval ->> 'v1_next_candidates', '-')
    || ' 件 (固定 ' || coalesce(v_eval ->> 'v1_next_fixed', '-')
    || ' 件, プール ' || coalesce(v_eval ->> 'v1_pool', '-') || ' 件)'
    || ' (最終正常観測 '
    || coalesce(to_char((v_eval ->> 'last_ok_checked_at')::timestamptz at time zone 'Asia/Tokyo', 'MM-DD HH24:MI'), 'なし')
    || ')';

  -- Self-monitoring first: a stale checker means stock cannot be
  -- judged at all, which is itself worth one warning signal.
  if (v_eval ->> 'monitor_stale')::boolean then
    perform public.apply_quiz_stock_signal_v1(
      'quiz:stock-monitor-stale', 'quiz', null, 'ivrm', 'quiz',
      'quiz-stock-checker', 'クイズ在庫チェッカー', 'quiz_stock_monitor_stale',
      true, 'warning', p_now,
      'quiz_stock_monitor_stale: クイズ在庫チェッカーの正常な観測が '
        || (v_eval ->> 'stale_after_seconds')
        || ' 秒以上途絶えています (最終観測: '
        || coalesce(v_eval ->> 'last_any_status', 'なし') || ' / '
        || coalesce(to_char((v_eval ->> 'last_any_checked_at')::timestamptz at time zone 'Asia/Tokyo', 'MM-DD HH24:MI'), 'なし')
        || ')。監視が機能していないため、問題在庫の枯渇を検知できない状態です。',
      'クイズ在庫監視 / チェック停止', '/');
  else
    perform public.apply_quiz_stock_signal_v1(
      'quiz:stock-monitor-stale', 'quiz', null, 'ivrm', 'quiz',
      'quiz-stock-checker', 'クイズ在庫チェッカー', 'quiz_stock_monitor_stale',
      false, 'warning', p_now,
      'quiz_stock_monitor_recovered: クイズ在庫チェッカーの観測が再開しました (' || v_counts_text || ')。',
      'クイズ在庫監視 / チェック停止', '/');
  end if;

  -- V2 daily stock. 'unknown' / 'disabled' deliberately leave the
  -- signal untouched: missing data or an intentionally stopped
  -- stream must neither open nor close an alert.
  if v_eval -> 'v2' ->> 'status' in ('warning', 'critical') then
    v_reason := case v_eval -> 'v2' ->> 'reason_code'
      when 'v2_today_empty' then
        'quiz_v2_today_empty: 本日 (JST) の V2 デイリー問題が出題可能な状態にありません (当日 ready 0 件, ' || v_counts_text || ')。approved / published の問題が当日分に存在しません。'
      else
        'quiz_v2_next_empty: 明日 (JST) の V2 デイリー問題が 0 件のまま閾値時刻を過ぎました (' || v_counts_text || ')。'
        || case when (v_eval ->> 'v2_next_draft')::integer > 0
             then '下書きは ' || (v_eval ->> 'v2_next_draft') || ' 件ありますが、承認されていないため出題できません。'
             else '下書きも存在しません。' end
    end;
    perform public.apply_quiz_stock_signal_v1(
      'quiz:v2-daily-stock', 'quiz', null, 'ivrm', 'quiz',
      'v2-daily', 'V2 デイリー問題', 'quiz_v2_daily_stock',
      true, v_eval -> 'v2' ->> 'severity', p_now, v_reason,
      'クイズ在庫 / V2 デイリー', '/');
    v_worst := v_eval -> 'v2' ->> 'status';
  elsif v_eval -> 'v2' ->> 'status' = 'ok' then
    perform public.apply_quiz_stock_signal_v1(
      'quiz:v2-daily-stock', 'quiz', null, 'ivrm', 'quiz',
      'v2-daily', 'V2 デイリー問題', 'quiz_v2_daily_stock',
      false, 'warning', p_now,
      'quiz_v2_stock_recovered: V2 デイリー問題の在庫は正常です (' || v_counts_text || ')。',
      'クイズ在庫 / V2 デイリー', '/');
  end if;

  -- V1 login-bonus stock.
  if v_eval -> 'v1' ->> 'status' in ('warning', 'critical') then
    v_reason := case v_eval -> 'v1' ->> 'reason_code'
      when 'v1_none_confirmed' then
        'quiz_v1_none_confirmed: 本日 (JST) の V1 ログインボーナス問題が「問題なし (none)」で確定しています (' || v_counts_text || ')。2026-11-01 の在庫切れ事故と同型のパターンです。'
      else
        'quiz_v1_next_empty: 明日 (JST) の V1 ログインボーナス候補問題が 0 件のまま閾値時刻を過ぎました (' || v_counts_text || ')。このままでは明日の publication が none で確定します。'
    end;
    perform public.apply_quiz_stock_signal_v1(
      'quiz:v1-stock', 'quiz', null, 'ivrm', 'quiz',
      'v1-login-bonus', 'V1 ログインボーナス問題', 'quiz_v1_stock',
      true, v_eval -> 'v1' ->> 'severity', p_now, v_reason,
      'クイズ在庫 / V1 ログインボーナス', '/');
    if v_worst is null
      or public.notification_severity_rank_v1(v_eval -> 'v1' ->> 'severity')
         > public.notification_severity_rank_v1(case v_worst when 'warning' then 'warning' else 'critical' end) then
      v_worst := v_eval -> 'v1' ->> 'status';
    end if;
  elsif v_eval -> 'v1' ->> 'status' = 'ok' then
    perform public.apply_quiz_stock_signal_v1(
      'quiz:v1-stock', 'quiz', null, 'ivrm', 'quiz',
      'v1-login-bonus', 'V1 ログインボーナス問題', 'quiz_v1_stock',
      false, 'warning', p_now,
      'quiz_v1_stock_recovered: V1 ログインボーナス問題の在庫は正常です (' || v_counts_text || ')。',
      'クイズ在庫 / V1 ログインボーナス', '/');
  end if;

  -- V2 runway (warning only).
  if v_eval -> 'runway' ->> 'status' = 'warning' then
    perform public.apply_quiz_stock_signal_v1(
      'quiz:v2-stock-runway', 'quiz', null, 'ivrm', 'quiz',
      'v2-daily', 'V2 デイリー問題', 'quiz_v2_stock_runway',
      true, 'warning', p_now,
      'quiz_v2_runway_low: V2 デイリー問題の出題可能な残りが ' || (v_eval ->> 'v2_runway_days') || ' 日分しかありません (' || v_counts_text || ')。週末の投入停止で即枯渇する水準です。',
      'クイズ在庫 / V2 残日数', '/');
    if v_worst is null then
      v_worst := 'warning';
    end if;
  elsif v_eval -> 'runway' ->> 'status' = 'ok' then
    perform public.apply_quiz_stock_signal_v1(
      'quiz:v2-stock-runway', 'quiz', null, 'ivrm', 'quiz',
      'v2-daily', 'V2 デイリー問題', 'quiz_v2_stock_runway',
      false, 'warning', p_now,
      'quiz_v2_runway_recovered: V2 デイリー問題の残日に余裕があります (' || v_counts_text || ')。',
      'クイズ在庫 / V2 残日数', '/');
  end if;

  if v_worst is not null then
    return v_worst;
  end if;
  return v_eval ->> 'status';
end;
$$;
revoke all on function public.reconcile_quiz_stock_signals_v1(timestamptz) from public, anon, authenticated;
grant execute on function public.reconcile_quiz_stock_signals_v1(timestamptz) to service_role;

-- 8. Retention for observations (7 days, mirroring points).
create or replace function public.prune_quiz_stock_observations_v1()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  delete from public.quiz_stock_observations
  where checked_at < clock_timestamp() - interval '7 days';
end;
$$;
revoke all on function public.prune_quiz_stock_observations_v1() from public, anon, authenticated;
grant execute on function public.prune_quiz_stock_observations_v1() to service_role;
