-- Issue #184 是正スライス 再現テスト（repo の supabase/tests 契約テスト形式）
--
-- 使い方:
--   1. 本番 ivrm_dashboard の schema-only コピー等で作った scratch DB を用意する
--   2. 修正前確認: そのまま実行すると、P2 / P3 の assertion で落ちる
--      （= 2026-11-11 の誤検知が再現したことの確認になる）
--   3. 修正後確認: 202611110002_notification_container_signal_fixes.sql を
--      適用してから実行すると、全 assertion を通過して 'REPRO184 ALL PASS'
--      が表示される
--   トランザクションは常に rollback されるため、fixture は残らない。
--   実行は DB owner（または superuser）で行うこと（RLS のため）。
--
-- 駆動方法は実経路そのもの: container_samples への INSERT が
-- capture → monitoring_events → notification trigger → apply を起動し、
-- reconcile は実関数を直接呼ぶ。時刻は実時刻ベース（reconcile の
-- 45 秒窓に合わせ、最新サンプルは実行直前の時刻で投入する）。

begin;

create or replace function pg_temp.repro184_sample(
  p_host_id uuid,
  p_container text,
  p_received_at timestamptz,
  p_state text,
  p_health text,
  p_restart_count integer default 0,
  p_oom_killed boolean default false,
  p_exit_code integer default null
)
returns void
language plpgsql
as $$
declare
  v_heartbeat_id bigint;
begin
  insert into public.agent_heartbeats (
    host_id, agent_version, received_at, sent_at,
    request_nonce, body_sha256,
    cpu_count, memory_total_bytes, memory_available_bytes,
    disk_total_bytes, disk_available_bytes,
    load_average_1, load_average_5, load_average_15, uptime_seconds
  ) values (
    p_host_id, 'repro-184', p_received_at, p_received_at,
    md5(random()::text || clock_timestamp()::text),
    md5(random()::text || clock_timestamp()::text) || md5(random()::text),
    2, 1024, 512, 1024, 512, 0.1, 0.1, 0.1, 60
  )
  returning id into v_heartbeat_id;

  insert into public.container_samples (
    heartbeat_id, host_id, received_at, container_name,
    state, health, restart_count, oom_killed, exit_code
  ) values (
    v_heartbeat_id, p_host_id, p_received_at, p_container,
    p_state, p_health, p_restart_count, p_oom_killed, p_exit_code
  );
end;
$$;

create or replace function pg_temp.repro184_assert(
  p_condition boolean,
  p_name text
)
returns void
language plpgsql
as $$
begin
  if not coalesce(p_condition, false) then
    raise exception 'REPRO184 assertion failed: %', p_name;
  end if;
  raise notice 'REPRO184 ok: %', p_name;
end;
$$;

do $$
declare
  v_host_id uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
  v_signal record;
  v_count integer;
begin
  insert into public.hosts (id, server_id, display_name, provider, enabled)
  values (v_host_id, 'repro-184', 'Issue #184 reproduction', 'other', true);

  insert into public.container_expectations (host_id, container_name, expected_state)
  values
    (v_host_id, 'mc-main-like', 'running'),
    (v_host_id, 'mc-resource-like', 'on-demand'),
    (v_host_id, 'stopped-like', 'stopped'),
    (v_host_id, 'slow-like', 'running');

  -- ================================================================
  -- 事象3+4 の再現: auto-scale コンテナの起動→停止
  --   2026-11-11 実績: mc-resource が 16:06 に起動し State 発生、
  --   同分に重大化、16:12 に復旧（いずれも設計どおりの正常動作）
  --   修正後: on-demand では State Signal も outbox も一切出ない
  -- ================================================================
  perform pg_temp.repro184_sample(v_host_id, 'mc-resource-like', v_now - interval '180 seconds', 'exited', 'none', 0, false, 0);
  perform pg_temp.repro184_sample(v_host_id, 'mc-resource-like', v_now - interval '60 seconds', 'running', 'healthy');
  perform public.reconcile_notification_container_signals_v1();
  perform pg_temp.repro184_sample(v_host_id, 'mc-resource-like', v_now - interval '30 seconds', 'exited', 'none', 0, false, 0);
  perform public.reconcile_notification_container_signals_v1();

  select count(*) into v_count
  from public.notification_outbox
  where host_id = v_host_id
    and entity_name = 'mc-resource-like'
    and signal_key is not null;
  perform pg_temp.repro184_assert(v_count = 0, 'p1_on_demand_no_state_notifications');

  select count(*) into v_count
  from public.notification_signal_state
  where host_id = v_host_id
    and entity_name = 'mc-resource-like'
    and active;
  perform pg_temp.repro184_assert(v_count = 0, 'p1_on_demand_no_active_signals');

  -- on-demand でも稼働中の unhealthy は critical で立つ（running 同格）
  perform pg_temp.repro184_sample(v_host_id, 'mc-resource-like', v_now - interval '20 seconds', 'running', 'unhealthy');
  select severity, active into v_signal
  from public.notification_signal_state
  where host_id = v_host_id
    and entity_name = 'mc-resource-like'
    and signal_type = 'health_changed';
  perform pg_temp.repro184_assert(
    v_signal.active and v_signal.severity = 'critical',
    'p1_on_demand_unhealthy_is_critical'
  );
  perform pg_temp.repro184_sample(v_host_id, 'mc-resource-like', v_now - interval '10 seconds', 'running', 'healthy');

  -- ================================================================
  -- P2 の回帰: expected=stopped の running 化は warning のまま。
  --   分類器（event）が warning で開いた Signal を、直後の reconcile が
  --   critical へ引き上げて escalated を作らないこと。
  --   修正前はここで severity='critical' になり assertion が落ちる。
  -- ================================================================
  perform pg_temp.repro184_sample(v_host_id, 'stopped-like', v_now - interval '90 seconds', 'exited', 'none', 0, false, 0);
  perform pg_temp.repro184_sample(v_host_id, 'stopped-like', v_now - interval '30 seconds', 'running', 'healthy');
  perform public.reconcile_notification_container_signals_v1();

  select severity, active into v_signal
  from public.notification_signal_state
  where host_id = v_host_id
    and entity_name = 'stopped-like'
    and signal_type = 'state_changed';
  perform pg_temp.repro184_assert(
    v_signal.active and v_signal.severity = 'warning',
    'p2_stopped_running_stays_warning'
  );

  select count(*) into v_count
  from public.notification_outbox
  where host_id = v_host_id
    and entity_name = 'stopped-like'
    and transition = 'escalated';
  perform pg_temp.repro184_assert(v_count = 0, 'p2_no_escalation_from_reconcile');

  -- 写像の一致を単体でも固定する（分類器 vs 共通関数）
  perform pg_temp.repro184_assert(
    public.classify_container_monitoring_event_v2('stopped', 'state_changed', 'exited', 'running')
      = public.notification_container_state_violation_v1('stopped', 'running'),
    'p2_map_match_stopped_running'
  );
  perform pg_temp.repro184_assert(
    public.classify_container_monitoring_event_v2('absent', 'state_changed', 'not_found', 'running')
      = public.notification_container_state_violation_v1('absent', 'running'),
    'p2_map_match_absent_running'
  );
  perform pg_temp.repro184_assert(
    public.classify_container_monitoring_event_v2('running', 'state_changed', 'running', 'created')
      = public.notification_container_state_violation_v1('running', 'created'),
    'p2_map_match_running_created'
  );
  perform pg_temp.repro184_assert(
    public.classify_container_monitoring_event_v2('running', 'state_changed', 'running', 'exited')
      = public.notification_container_state_violation_v1('running', 'exited'),
    'p2_map_match_running_exited'
  );

  -- ================================================================
  -- 事象1+2 の再現: 再起動に伴う Health starting → healthy
  --   2026-11-11 実績: mc-main が 16:03 に Health 発生（warning）、
  --   healthy 到達で復旧。通常起動のたびに出るペア通知だった。
  --   修正後: 猶予内では Signal も outbox も出ない
  -- ================================================================
  perform pg_temp.repro184_sample(v_host_id, 'mc-main-like', v_now - interval '150 seconds', 'running', 'healthy');
  perform pg_temp.repro184_sample(v_host_id, 'mc-main-like', v_now - interval '40 seconds', 'running', 'starting');
  perform public.reconcile_notification_container_signals_v1();
  perform pg_temp.repro184_sample(v_host_id, 'mc-main-like', v_now - interval '10 seconds', 'running', 'healthy');
  perform public.reconcile_notification_container_signals_v1();

  select count(*) into v_count
  from public.notification_outbox
  where host_id = v_host_id
    and entity_name = 'mc-main-like'
    and signal_key is not null;
  perform pg_temp.repro184_assert(v_count = 0, 'p3_starting_within_grace_no_notifications');

  select count(*) into v_count
  from public.notification_signal_state
  where host_id = v_host_id
    and entity_name = 'mc-main-like'
    and active;
  perform pg_temp.repro184_assert(v_count = 0, 'p3_starting_within_grace_no_active_signals');

  -- monitoring_events には starting が warning で記録され続けること
  -- （タイムラインと Incident 側の見え方を変えない）
  select count(*) into v_count
  from public.monitoring_events
  where host_id = v_host_id
    and container_name = 'mc-main-like'
    and event_type = 'health_changed'
    and to_value = 'starting'
    and severity = 'warning';
  perform pg_temp.repro184_assert(v_count = 1, 'p3_starting_event_still_recorded_as_warning');

  -- ================================================================
  -- P3 の陽性側: starting が 300 秒を超えて継続したら warning で立つ
  -- ================================================================
  perform pg_temp.repro184_sample(v_host_id, 'slow-like', v_now - interval '420 seconds', 'running', 'starting');
  perform pg_temp.repro184_sample(v_host_id, 'slow-like', v_now - interval '200 seconds', 'running', 'starting');
  perform pg_temp.repro184_sample(v_host_id, 'slow-like', v_now - interval '10 seconds', 'running', 'starting');
  perform public.reconcile_notification_container_signals_v1();

  select severity, active into v_signal
  from public.notification_signal_state
  where host_id = v_host_id
    and entity_name = 'slow-like'
    and signal_type = 'health_changed';
  perform pg_temp.repro184_assert(
    v_signal.active and v_signal.severity = 'warning',
    'p3_starting_over_grace_opens_warning'
  );

  raise notice 'REPRO184 ALL PASS';
end;
$$;

rollback;
