\set ON_ERROR_STOP on
-- Issue ivrm-web#749: quiz stock monitor contracts. Runs in the same
-- session as the cloud monitor contracts (see
-- tests/cloud-monitor-db.sql), right after
-- supabase/migrations/202611140007_quiz_stock_monitor.sql.
-- All clocks are injected, so the JST threshold boundaries are exact.
-- Observation argument order: status, slot_day, target_day,
-- v2_today_ready, v2_today_draft, v2_next_ready, v2_next_draft,
-- v2_next_bonus_ready, v2_runway_days, v1_today_none_confirmed,
-- v1_next_candidates, v1_next_fixed, v1_pool, detail, checked_at.

-- The monitor must ship disabled, and a disabled monitor judges
-- nothing.
do $$
begin
  if (select enabled from public.quiz_stock_monitor_config where id = 1) then
    raise exception 'monitor must default to disabled';
  end if;
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-15', '2026-11-16',
    1, 0, 1, 0, 1, 5, false, 3, 1, 2, null, '2026-11-15 12:00:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-15 12:00:00+09'::timestamptz) <> 'disabled' then
    raise exception 'disabled monitor must report disabled';
  end if;
  if exists (select 1 from public.notification_signal_state where source_type = 'quiz')
    or exists (select 1 from public.notification_outbox where source_type = 'quiz') then
    raise exception 'disabled monitor emitted signal state or notifications';
  end if;
  delete from public.quiz_stock_observations;
end; $$;

-- ACL: the new surface must not be reachable by anon/authenticated.
do $$
begin
  if has_table_privilege('anon', 'public.quiz_stock_observations', 'SELECT')
    or has_table_privilege('authenticated', 'public.quiz_stock_monitor_config', 'SELECT')
    or has_function_privilege('authenticated', 'public.record_quiz_stock_observation_v1(text,date,date,integer,integer,integer,integer,integer,integer,boolean,integer,integer,integer,text,timestamptz)', 'EXECUTE')
    or has_function_privilege('anon', 'public.reconcile_quiz_stock_signals_v1(timestamptz)', 'EXECUTE') then
    raise exception 'public access was granted';
  end if;
  if not has_function_privilege('service_role', 'public.record_quiz_stock_observation_v1(text,date,date,integer,integer,integer,integer,integer,integer,boolean,integer,integer,integer,text,timestamptz)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.reconcile_quiz_stock_signals_v1(timestamptz)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.evaluate_quiz_stock_v1(timestamptz)', 'EXECUTE') then
    raise exception 'service_role access missing';
  end if;
end; $$;

-- Invalid observations are rejected (ok without counts, counts on a
-- non-ok status, negative counts, runway out of range, target day
-- that is not slot day + 1).
do $$
begin
  begin
    perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
      1, 0, null, 0, 1, 5, false, 3, 1, 2, null, '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'ok observation without a count accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_quiz_stock_observation_v1('unreachable', null, null,
      null, null, 3, null, null, null, null, null, null, null, 'x', '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'non-ok observation with counts accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
      -1, 0, 1, 0, 1, 5, false, 3, 1, 2, null, '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'negative count accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
      1, 0, 1, 0, 1, 15, false, 3, 1, 2, null, '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'runway above the 14-day cap accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-16',
      1, 0, 1, 0, 1, 5, false, 3, 1, 2, null, '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'target day other than slot day + 1 accepted';
  exception when sqlstate '22023' then null;
  end;
end; $$;

update public.quiz_stock_monitor_config set enabled = true where id = 1;

-- Group A (slot day 2026-11-16): V2 next-day thresholds. Warning at
-- 12:00, escalation to critical at 21:00, no duplicates, automatic
-- recovery with suppression of undelivered alerts. The warning
-- reason must call out that drafts alone cannot be published.
do $$
begin
  -- 11:59 JST: tomorrow empty is not yet a signal (threshold 12:00).
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
    1, 0, 0, 2, 0, 0, false, 3, 0, 3, null, '2026-11-16 11:59:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-16 11:59:00+09'::timestamptz) <> 'ok' then
    raise exception '11:59 empty tomorrow must be ok';
  end if;
  if exists (select 1 from public.notification_signal_state where source_type = 'quiz')
    or exists (select 1 from public.notification_outbox where source_type = 'quiz') then
    raise exception 'signal emitted before the noon threshold';
  end if;

  -- 12:00 JST: tomorrow still empty -> warning, exactly once, and
  -- the reason mentions the 2 unapproved drafts.
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
    1, 0, 0, 2, 0, 0, false, 3, 0, 3, null, '2026-11-16 12:00:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-16 12:00:00+09'::timestamptz) <> 'warning' then
    raise exception 'noon empty tomorrow must evaluate to warning';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:v2-daily-stock' and active and severity = 'warning'
                   and reason like '%下書きは 2 件%') then
    raise exception 'warning signal missing or draft count not in reason';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'quiz:v2-daily-stock' and transition = 'opened' and severity = 'warning' and status = 'pending') <> 1 then
    raise exception 'warning opened notification missing or duplicated';
  end if;

  -- Re-evaluation without change must not duplicate the notification.
  perform public.reconcile_quiz_stock_signals_v1('2026-11-16 12:05:00+09'::timestamptz);
  if (select count(*) from public.notification_outbox where source_type = 'quiz') <> 1 then
    raise exception 'unchanged evaluation duplicated a notification';
  end if;

  -- 21:00 JST: still empty -> critical (escalation).
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
    1, 0, 0, 2, 0, 0, false, 3, 0, 3, null, '2026-11-16 21:00:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-16 21:00:00+09'::timestamptz) <> 'critical' then
    raise exception 'empty tomorrow at 21:00 must evaluate to critical';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'quiz:v2-daily-stock' and transition = 'escalated' and severity = 'critical') <> 1 then
    raise exception 'escalation notification missing';
  end if;

  -- Recovery: tomorrow is stocked again -> signal closes, a recovery
  -- row is queued, and the still-undelivered opened/escalated rows
  -- are suppressed.
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-16', '2026-11-17',
    1, 0, 1, 0, 1, 5, false, 3, 1, 2, null, '2026-11-16 21:10:00+09'::timestamptz);
  perform public.reconcile_quiz_stock_signals_v1('2026-11-16 21:10:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'quiz:v2-daily-stock' and active) then
    raise exception 'signal did not recover';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'quiz:v2-daily-stock' and transition = 'recovered') <> 1 then
    raise exception 'recovery notification missing';
  end if;
  if exists (select 1 from public.notification_outbox
             where signal_key = 'quiz:v2-daily-stock'
               and transition in ('opened', 'escalated') and status = 'pending') then
    raise exception 'undelivered alerts survived recovery';
  end if;

  -- The checker stayed fresh throughout, so the self-monitor signal
  -- must never have opened; the runway signal must stay silent while
  -- the next day itself is missing (the stock signal owns that).
  if exists (select 1 from public.notification_outbox where signal_key in ('quiz:stock-monitor-stale', 'quiz:v2-stock-runway'))
    or exists (select 1 from public.notification_signal_state where signal_key = 'quiz:v2-stock-runway') then
    raise exception 'stale or runway fired unexpectedly (group A)';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'quiz';
delete from public.notification_signal_state where source_type = 'quiz';
delete from public.quiz_stock_observations;

-- Group B (slot day 2026-11-17): same-day manifestations are critical
-- at any time of day: V2 today empty, and a V1 publication already
-- fixed to 'none'.
do $$
begin
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-17', '2026-11-18',
    0, 1, 1, 0, 1, 5, false, 2, 0, 2, null, '2026-11-17 10:00:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-17 10:00:00+09'::timestamptz) <> 'critical' then
    raise exception 'V2 today empty must be critical immediately';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:v2-daily-stock' and active and severity = 'critical') then
    raise exception 'V2 today-empty critical signal missing';
  end if;

  -- V2 recovers, but today's V1 publication is fixed to 'none'.
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-17', '2026-11-18',
    1, 0, 1, 0, 1, 5, true, 2, 0, 2, null, '2026-11-17 10:10:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-17 10:10:00+09'::timestamptz) <> 'critical' then
    raise exception 'V1 none-confirmed must be critical immediately';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:v1-stock' and active and severity = 'critical'
                   and reason like '%2026-11-01%') then
    raise exception 'V1 none-confirmed signal missing or reason lacks the incident reference';
  end if;
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'quiz:v2-daily-stock' and active) then
    raise exception 'V2 signal did not recover in group B';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'quiz';
delete from public.notification_signal_state where source_type = 'quiz';
delete from public.quiz_stock_observations;

-- Group C (slot day 2026-11-18): the runway warning. Two ready days
-- left at noon -> warning; three days -> recovery; and the stock
-- signal never fires while the next day itself is stocked.
do $$
begin
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-18', '2026-11-19',
    1, 0, 1, 0, 1, 2, false, 3, 1, 2, null, '2026-11-18 11:59:00+09'::timestamptz);
  perform public.reconcile_quiz_stock_signals_v1('2026-11-18 11:59:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state where source_type = 'quiz') then
    raise exception 'runway fired before the noon threshold';
  end if;

  perform public.record_quiz_stock_observation_v1('ok', '2026-11-18', '2026-11-19',
    1, 0, 1, 0, 1, 2, false, 3, 1, 2, null, '2026-11-18 12:00:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-18 12:00:00+09'::timestamptz) <> 'warning' then
    raise exception 'runway of 2 days at noon must evaluate to warning';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:v2-stock-runway' and active and severity = 'warning') then
    raise exception 'runway warning signal missing';
  end if;
  if exists (select 1 from public.notification_signal_state where signal_key = 'quiz:v2-daily-stock')
    or exists (select 1 from public.notification_outbox where signal_key = 'quiz:v2-daily-stock') then
    raise exception 'stock signal fired while the next day is stocked';
  end if;

  perform public.record_quiz_stock_observation_v1('ok', '2026-11-18', '2026-11-19',
    1, 0, 1, 0, 1, 3, false, 3, 1, 2, null, '2026-11-18 12:10:00+09'::timestamptz);
  perform public.reconcile_quiz_stock_signals_v1('2026-11-18 12:10:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'quiz:v2-stock-runway' and active) then
    raise exception 'runway signal did not recover at 3 days';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'quiz:v2-stock-runway' and transition = 'recovered') <> 1 then
    raise exception 'runway recovery notification missing';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'quiz';
delete from public.notification_signal_state where source_type = 'quiz';
delete from public.quiz_stock_observations;

-- Group D (slot day 2026-11-19): fail-safe when ivrm_api cannot be
-- measured. No ok observation -> no stock signal is ever judged, and
-- the dead checker itself surfaces as quiz:stock-monitor-stale.
do $$
begin
  if public.reconcile_quiz_stock_signals_v1('2026-11-19 12:00:00+09'::timestamptz) <> 'unknown' then
    raise exception 'missing data must evaluate to unknown';
  end if;
  if exists (select 1 from public.notification_signal_state where signal_key in ('quiz:v2-daily-stock', 'quiz:v1-stock', 'quiz:v2-stock-runway'))
    or exists (select 1 from public.notification_outbox where signal_key in ('quiz:v2-daily-stock', 'quiz:v1-stock', 'quiz:v2-stock-runway')) then
    raise exception 'stock signal judged without data';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:stock-monitor-stale' and active and severity = 'warning') then
    raise exception 'monitor-stale did not open for a silent checker';
  end if;

  perform public.record_quiz_stock_observation_v1('unconfigured', null, null,
    null, null, null, null, null, null, null, null, null, null, 'not_configured', '2026-11-19 12:05:00+09'::timestamptz);
  perform public.record_quiz_stock_observation_v1('unreachable', null, null,
    null, null, null, null, null, null, null, null, null, null, 'query_failed', '2026-11-19 12:10:00+09'::timestamptz);
  perform public.reconcile_quiz_stock_signals_v1('2026-11-19 12:10:00+09'::timestamptz);
  if exists (select 1 from public.notification_outbox where signal_key in ('quiz:v2-daily-stock', 'quiz:v1-stock', 'quiz:v2-stock-runway')) then
    raise exception 'stock alert fired on unmeasurable data';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:stock-monitor-stale' and active) then
    raise exception 'monitor-stale closed while still unmeasurable';
  end if;

  -- A healthy observation closes the stale signal and opens nothing.
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-19', '2026-11-20',
    1, 0, 1, 0, 1, 5, false, 3, 1, 2, null, '2026-11-19 12:15:00+09'::timestamptz);
  perform public.reconcile_quiz_stock_signals_v1('2026-11-19 12:15:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'quiz:stock-monitor-stale' and active) then
    raise exception 'monitor-stale did not recover';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'quiz:stock-monitor-stale' and transition = 'recovered') <> 1 then
    raise exception 'monitor-stale recovery notification missing';
  end if;
  if exists (select 1 from public.notification_outbox where signal_key in ('quiz:v2-daily-stock', 'quiz:v1-stock', 'quiz:v2-stock-runway')) then
    raise exception 'stock alert fired on a healthy day';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'quiz';
delete from public.notification_signal_state where source_type = 'quiz';
delete from public.quiz_stock_observations;

-- Group E (slot day 2026-11-20): a stale ok observation (checker died
-- after the morning) must not be judged as a stock outage even though
-- it reported an empty tomorrow; only the monitor-stale signal opens.
do $$
begin
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-20', '2026-11-21',
    1, 0, 0, 0, 0, 0, false, 0, 0, 0, null, '2026-11-20 11:00:00+09'::timestamptz);
  if public.reconcile_quiz_stock_signals_v1('2026-11-20 12:00:00+09'::timestamptz) <> 'unknown' then
    raise exception 'stale observation must evaluate to unknown';
  end if;
  if exists (select 1 from public.notification_outbox where signal_key in ('quiz:v2-daily-stock', 'quiz:v1-stock', 'quiz:v2-stock-runway')) then
    raise exception 'stock alert fired on stale data';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:stock-monitor-stale' and active) then
    raise exception 'monitor-stale did not open for a dead checker';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'quiz';
delete from public.notification_signal_state where source_type = 'quiz';
delete from public.quiz_stock_observations;

-- Group F (slot day 2026-11-21): per-stream switches. A stream with
-- its switch off is never judged and never signalled, while the
-- other stream keeps working.
do $$
declare v_eval jsonb;
begin
  update public.quiz_stock_monitor_config set v1_enabled = false where id = 1;
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-21', '2026-11-22',
    1, 0, 1, 0, 1, 5, true, 0, 0, 0, null, '2026-11-21 12:00:00+09'::timestamptz);
  v_eval := public.evaluate_quiz_stock_v1('2026-11-21 12:00:00+09'::timestamptz);
  if v_eval -> 'v1' ->> 'status' <> 'disabled' then
    raise exception 'v1 section must be disabled when v1_enabled is false';
  end if;
  perform public.reconcile_quiz_stock_signals_v1('2026-11-21 12:00:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state where signal_key = 'quiz:v1-stock')
    or exists (select 1 from public.notification_outbox where signal_key = 'quiz:v1-stock') then
    raise exception 'disabled v1 stream emitted a signal';
  end if;

  update public.quiz_stock_monitor_config set v1_enabled = true, v2_enabled = false where id = 1;
  perform public.record_quiz_stock_observation_v1('ok', '2026-11-21', '2026-11-22',
    1, 0, 0, 0, 0, 0, true, 2, 0, 2, null, '2026-11-21 12:10:00+09'::timestamptz);
  perform public.reconcile_quiz_stock_signals_v1('2026-11-21 12:10:00+09'::timestamptz);
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'quiz:v1-stock' and active and severity = 'critical') then
    raise exception 'v1 signal missing after re-enabling v1';
  end if;
  if exists (select 1 from public.notification_signal_state where signal_key in ('quiz:v2-daily-stock', 'quiz:v2-stock-runway'))
    or exists (select 1 from public.notification_outbox where signal_key in ('quiz:v2-daily-stock', 'quiz:v2-stock-runway')) then
    raise exception 'disabled v2 stream emitted a signal';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'quiz';
delete from public.notification_signal_state where source_type = 'quiz';
delete from public.quiz_stock_observations;
update public.quiz_stock_monitor_config set enabled = false, v1_enabled = true, v2_enabled = true where id = 1;

select 'quiz stock monitor contracts passed' as result;
