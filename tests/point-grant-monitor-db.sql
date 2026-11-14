\set ON_ERROR_STOP on
-- Issue #221: point-grant liveness contracts. Runs in the same session
-- as the cloud monitor contracts (see tests/cloud-monitor-db.sql),
-- right after supabase/migrations/202611140003_point_grant_liveness.sql.
-- All clocks are injected, so the JST threshold boundaries are exact.

-- The monitor must ship disabled, and a disabled monitor judges nothing.
do $$
begin
  if (select enabled from public.point_grant_monitor_config where id = 1) then
    raise exception 'monitor must default to disabled';
  end if;
  perform public.record_point_grant_observation_v1('ok', 0, 0, 0, null, '2026-11-15 15:30:00+09'::timestamptz);
  if public.reconcile_point_grant_signals_v1('2026-11-15 15:30:00+09'::timestamptz) <> 'disabled' then
    raise exception 'disabled monitor must report disabled';
  end if;
  if exists (select 1 from public.notification_signal_state where source_type = 'points')
    or exists (select 1 from public.notification_outbox where source_type = 'points') then
    raise exception 'disabled monitor emitted signal state or notifications';
  end if;
  delete from public.point_grant_observations;
end; $$;

-- ACL: the new surface must not be reachable by anon/authenticated.
do $$
begin
  if has_table_privilege('anon', 'public.point_grant_observations', 'SELECT')
    or has_table_privilege('authenticated', 'public.point_grant_monitor_config', 'SELECT')
    or has_function_privilege('authenticated', 'public.record_point_grant_observation_v1(text,integer,integer,integer,text,timestamptz)', 'EXECUTE')
    or has_function_privilege('anon', 'public.reconcile_point_grant_signals_v1(timestamptz)', 'EXECUTE') then
    raise exception 'public access was granted';
  end if;
  if not has_function_privilege('service_role', 'public.record_point_grant_observation_v1(text,integer,integer,integer,text,timestamptz)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.reconcile_point_grant_signals_v1(timestamptz)', 'EXECUTE') then
    raise exception 'service_role access missing';
  end if;
end; $$;

-- Invalid observations are rejected (ok without counts, counts on a
-- non-ok status, negative counts).
do $$
begin
  begin
    perform public.record_point_grant_observation_v1('ok', null, 1, null, null, '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'ok observation without claims count accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_point_grant_observation_v1('unreachable', 3, null, null, 'x', '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'non-ok observation with counts accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.record_point_grant_observation_v1('ok', -1, 0, null, null, '2026-11-16 09:00:00+09'::timestamptz);
    raise exception 'negative count accepted';
  exception when sqlstate '22023' then null;
  end;
end; $$;

update public.point_grant_monitor_config set enabled = true where id = 1;

-- Group A (2026-11-16): threshold boundaries, dedupe, earn escalation,
-- automatic recovery with suppression of undelivered alerts.
do $$
declare v_eval jsonb;
begin
  -- 11:59 JST: zero counts are not yet a signal (threshold is 12:00).
  perform public.record_point_grant_observation_v1('ok', 0, 0, 0, null, '2026-11-16 11:59:00+09'::timestamptz);
  v_eval := public.evaluate_point_grant_liveness_v1('2026-11-16 11:59:00+09'::timestamptz);
  if v_eval ->> 'status' <> 'ok' then
    raise exception '11:59 zero counts must be ok, got %', v_eval ->> 'status';
  end if;
  perform public.reconcile_point_grant_signals_v1('2026-11-16 11:59:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state where source_type = 'points')
    or exists (select 1 from public.notification_outbox where source_type = 'points') then
    raise exception 'signal emitted before the noon threshold';
  end if;

  -- 12:00 JST: claims still 0 (earn flowing) -> warning, exactly once.
  perform public.record_point_grant_observation_v1('ok', 0, 5, 3, null, '2026-11-16 12:00:00+09'::timestamptz);
  if public.reconcile_point_grant_signals_v1('2026-11-16 12:00:00+09'::timestamptz) <> 'warning' then
    raise exception 'noon claims=0 must evaluate to warning';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'points:grant-liveness' and active and severity = 'warning') then
    raise exception 'warning signal not active';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'points:grant-liveness' and transition = 'opened' and severity = 'warning' and status = 'pending') <> 1 then
    raise exception 'warning opened notification missing or duplicated';
  end if;

  -- Re-evaluation without change must not duplicate the notification.
  perform public.reconcile_point_grant_signals_v1('2026-11-16 12:05:00+09'::timestamptz);
  if (select count(*) from public.notification_outbox where source_type = 'points') <> 1 then
    raise exception 'unchanged evaluation duplicated a notification';
  end if;

  -- earn drops to 0 -> critical via the earn rule (escalation).
  perform public.record_point_grant_observation_v1('ok', 0, 0, 3, null, '2026-11-16 12:10:00+09'::timestamptz);
  if public.reconcile_point_grant_signals_v1('2026-11-16 12:10:00+09'::timestamptz) <> 'critical' then
    raise exception 'earn=0 at noon must evaluate to critical';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'points:grant-liveness' and active and severity = 'critical') then
    raise exception 'signal did not escalate to critical';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'points:grant-liveness' and transition = 'escalated' and severity = 'critical') <> 1 then
    raise exception 'escalation notification missing';
  end if;

  -- Recovery: counts flow again -> signal closes, a recovery row is
  -- queued, and the still-undelivered opened/escalated rows are
  -- suppressed so a stale critical cannot be delivered late.
  perform public.record_point_grant_observation_v1('ok', 2, 2, 3, null, '2026-11-16 12:20:00+09'::timestamptz);
  perform public.reconcile_point_grant_signals_v1('2026-11-16 12:20:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'points:grant-liveness' and active) then
    raise exception 'signal did not recover';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'points:grant-liveness' and transition = 'recovered') <> 1 then
    raise exception 'recovery notification missing';
  end if;
  if exists (select 1 from public.notification_outbox
             where signal_key = 'points:grant-liveness'
               and transition in ('opened', 'escalated') and status = 'pending') then
    raise exception 'undelivered alerts survived recovery';
  end if;

  -- The checker stayed fresh throughout, so the self-monitor signal
  -- must never have opened.
  if exists (select 1 from public.notification_outbox where signal_key = 'points:grant-monitor-stale')
    or exists (select 1 from public.notification_signal_state where signal_key = 'points:grant-monitor-stale') then
    raise exception 'monitor-stale fired while the checker was fresh';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'points';
delete from public.notification_signal_state where source_type = 'points';
delete from public.point_grant_observations;

-- Group B (2026-11-17): claims-only escalation at the 15:00 boundary.
do $$
begin
  perform public.record_point_grant_observation_v1('ok', 0, 4, 1, null, '2026-11-17 12:00:00+09'::timestamptz);
  perform public.reconcile_point_grant_signals_v1('2026-11-17 12:00:00+09'::timestamptz);
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'points:grant-liveness' and active and severity = 'warning') then
    raise exception 'noon warning missing (group B)';
  end if;

  -- 14:59 is still warning territory for claims.
  perform public.record_point_grant_observation_v1('ok', 0, 4, 1, null, '2026-11-17 14:59:00+09'::timestamptz);
  perform public.reconcile_point_grant_signals_v1('2026-11-17 14:59:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'points:grant-liveness' and severity = 'critical') then
    raise exception 'claims escalated before 15:00';
  end if;

  -- 15:00 with claims still 0 -> critical.
  perform public.record_point_grant_observation_v1('ok', 0, 4, 1, null, '2026-11-17 15:00:00+09'::timestamptz);
  if public.reconcile_point_grant_signals_v1('2026-11-17 15:00:00+09'::timestamptz) <> 'critical' then
    raise exception 'claims=0 at 15:00 must evaluate to critical';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'points:grant-liveness' and transition = 'escalated' and severity = 'critical') <> 1 then
    raise exception 'claims escalation notification missing';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'points';
delete from public.notification_signal_state where source_type = 'points';
delete from public.point_grant_observations;

-- Group C (2026-11-18): fail-safe when ivrm_api cannot be measured.
-- No ok observation -> the grant signal is never judged, and the dead
-- checker itself surfaces as points:grant-monitor-stale (warning).
do $$
begin
  if public.reconcile_point_grant_signals_v1('2026-11-18 12:00:00+09'::timestamptz) <> 'unknown' then
    raise exception 'missing data must evaluate to unknown';
  end if;
  if exists (select 1 from public.notification_signal_state where signal_key = 'points:grant-liveness')
    or exists (select 1 from public.notification_outbox where signal_key = 'points:grant-liveness') then
    raise exception 'grant signal judged without data';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'points:grant-monitor-stale' and active and severity = 'warning') then
    raise exception 'monitor-stale did not open for a silent checker';
  end if;

  -- Unconfigured / unreachable runs keep the heartbeat alive but still
  -- provide nothing to judge: no grant alert may fire.
  perform public.record_point_grant_observation_v1('unconfigured', null, null, null, 'not_configured', '2026-11-18 12:05:00+09'::timestamptz);
  perform public.record_point_grant_observation_v1('unreachable', null, null, null, 'query_failed', '2026-11-18 12:10:00+09'::timestamptz);
  perform public.reconcile_point_grant_signals_v1('2026-11-18 12:10:00+09'::timestamptz);
  if exists (select 1 from public.notification_outbox where signal_key = 'points:grant-liveness') then
    raise exception 'grant alert fired on unmeasurable data';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'points:grant-monitor-stale' and active) then
    raise exception 'monitor-stale closed while still unmeasurable';
  end if;

  -- A healthy observation closes the stale signal and still opens
  -- nothing on the grant side.
  perform public.record_point_grant_observation_v1('ok', 3, 4, 2, null, '2026-11-18 12:15:00+09'::timestamptz);
  perform public.reconcile_point_grant_signals_v1('2026-11-18 12:15:00+09'::timestamptz);
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'points:grant-monitor-stale' and active) then
    raise exception 'monitor-stale did not recover';
  end if;
  if (select count(*) from public.notification_outbox
      where signal_key = 'points:grant-monitor-stale' and transition = 'recovered') <> 1 then
    raise exception 'monitor-stale recovery notification missing';
  end if;
  if exists (select 1 from public.notification_outbox where signal_key = 'points:grant-liveness') then
    raise exception 'grant alert fired on a healthy day';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'points';
delete from public.notification_signal_state where source_type = 'points';
delete from public.point_grant_observations;

-- Group D (2026-11-20): a stale ok observation (checker died after
-- the morning) must not be judged as a grant outage; only the
-- monitor-stale signal opens.
do $$
begin
  perform public.record_point_grant_observation_v1('ok', 0, 0, 0, null, '2026-11-20 11:00:00+09'::timestamptz);
  if public.reconcile_point_grant_signals_v1('2026-11-20 12:00:00+09'::timestamptz) <> 'unknown' then
    raise exception 'stale observation must evaluate to unknown';
  end if;
  if exists (select 1 from public.notification_outbox where signal_key = 'points:grant-liveness') then
    raise exception 'grant alert fired on stale data';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'points:grant-monitor-stale' and active) then
    raise exception 'monitor-stale did not open for a dead checker';
  end if;
end; $$;

delete from public.notification_outbox where source_type = 'points';
delete from public.notification_signal_state where source_type = 'points';
delete from public.point_grant_observations;
update public.point_grant_monitor_config set enabled = false where id = 1;

select 'point grant liveness contracts passed' as result;
