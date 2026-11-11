-- Issue #184 是正スライス: Container Signal の評価器統一と期待状態の拡張（PG17 前提）
--
-- P2: reconcile_notification_container_signals_v1 の severity 写像を
--     classify_container_monitoring_event_v2（イベント経路）に統一する。
--     従来は expected=stopped の running 化を分類器が warning、reconcile が
--     critical と評価し、severity rank の上昇だけで「重大化」が生成されていた
--     （2026-11-11 mc-resource の誤検知）。State の写像は共通関数
--     notification_container_state_violation_v1 に切り出し、reconcile は
--     その結果だけを使う。分類器側の State 写像はもともと統一表と一致するため
--     変更しない（DESIGN.md の統一表を参照）。
-- P1: expected_state に 'on-demand'（停止も起動も正常。auto-scale 型）を追加する。
--     container_expectations と monitoring_events の CHECK 制約を両方緩和し
--     （片方だけだと capture の events 投入が制約違反になる）、分類器と
--     reconcile に on-demand の分岐を足す。mc-resource の期待状態を移行する。
-- P3: health=starting に 300 秒の猶予を与える。event 経路では starting への
--     遷移を Signal 化せず（monitoring_events には warning で記録され続ける）、
--     reconcile が container_samples の連続 starting 区間から継続時間を求め、
--     猶予を超えた場合のみ warning で Signal を立てる。
--
-- 適用先: PG17 の ivrm_dashboard（C-d 移行先）。pg_cron は存在しないため
--   cron.schedule は含めない（起動は deploy/systemd の ivrm-dash-minutely が担う）。
-- 権限: CREATE OR REPLACE は既存の ACL を保持するため、置き換える関数には
--   grant/revoke を付けない。PG17 のロール体系は Supabase と異なる点に注意。
-- ロールバック: 置き換えた関数は旧定義（011 / 016 / 019）の再適用で戻せる。
--   ただし 'on-demand' の行が残っている間は CHECK 制約を戻せないため、
--   先に container_expectations のデータを従来値へ戻すこと。

-- =====================================================================
-- P1: CHECK 制約の緩和（'on-demand' の追加）
-- =====================================================================

alter table public.container_expectations
  drop constraint container_expectations_expected_state_check;
alter table public.container_expectations
  add constraint container_expectations_expected_state_check
  check (expected_state in ('running', 'stopped', 'absent', 'on-demand'));

alter table public.monitoring_events
  drop constraint monitoring_events_expected_check;
alter table public.monitoring_events
  add constraint monitoring_events_expected_check
  check (
    expected_state is null
    or expected_state in ('running', 'stopped', 'absent', 'on-demand')
  );

comment on column public.container_expectations.expected_state is
  'running=稼働期待、stopped=停止期待、absent=未作成期待、on-demand=オンデマンド起動期待（停止も起動も正常。稼働中のHealthのみ監視）';

-- =====================================================================
-- P2: State 写像の共通関数
--   戻り値: 'warning' / 'critical' / null（期待どおり = 違反なし）
--   classify_container_monitoring_event_v2 の state_changed 分類と
--   一致することを repro-test.sql で固定する。
-- =====================================================================

create or replace function public.notification_container_state_violation_v1(
  p_expected_state text,
  p_state text
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case
    -- on-demand は停止も起動も正常なので State では違反にならない
    when p_expected_state = 'on-demand' then null
    when p_expected_state = 'stopped' then
      case when p_state = 'running' then 'warning' else null end
    when p_expected_state = 'absent' then
      case when p_state = 'not_found' then null else 'warning' end
    else
      -- running（未登録時の既定を含む）
      case
        when p_state = 'running' then null
        when p_state in ('restarting', 'paused', 'created') then 'warning'
        else 'critical'
      end
  end;
$$;

revoke all on function public.notification_container_state_violation_v1(text, text)
  from public;

comment on function public.notification_container_state_violation_v1(text, text) is
  'Container State の期待状態違反の共通写像。分類器（イベント経路）と reconcile（現在状態経路）で severity を一致させるための正本（Issue #184 P2）';

-- =====================================================================
-- P1: 分類器に on-demand 分岐を追加
--   011 の現行定義を基に、restart_count_increased の直後へ分岐を挿入する。
--   それ以外の分岐・順序は変更しない。上部の recovery 3分岐は
--   expected_state が stopped / absent でない on-demand でも有効で、
--   稼働中に開いた Health / ExitCode Signal の復旧に使う。
-- =====================================================================

create or replace function public.classify_container_monitoring_event_v2(
  p_expected_state text,
  p_event_type text,
  p_from_value text,
  p_to_value text,
  p_numeric_value bigint default null,
  p_maintenance_active boolean default false
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if p_event_type in ('maintenance_started', 'maintenance_ended') then
    return 'info';
  end if;

  if p_event_type = 'oom_killed' then
    return 'critical';
  end if;

  if p_maintenance_active then
    return 'info';
  end if;

  -- stopped / absentではHealthとExitCodeは正常性判定のSignalにしないため、
  -- openerのないrecoveryを作らない。
  if p_event_type = 'health_changed'
     and p_expected_state is distinct from 'stopped'
     and p_expected_state is distinct from 'absent'
     and p_to_value = 'healthy'
     and p_from_value in ('unhealthy', 'starting', 'unknown') then
    return 'recovery';
  end if;

  if p_event_type = 'state_changed'
     and p_expected_state is distinct from 'stopped'
     and p_expected_state is distinct from 'absent'
     and p_to_value = 'running'
     and p_from_value is distinct from 'running' then
    return 'recovery';
  end if;

  if p_event_type = 'exit_code_changed'
     and p_expected_state is distinct from 'stopped'
     and p_expected_state is distinct from 'absent'
     and p_from_value is not null
     and p_from_value ~ '^-?[0-9]+$'
     and p_from_value::bigint <> 0
     and p_to_value is not null
     and p_to_value ~ '^-?[0-9]+$'
     and p_to_value::bigint = 0 then
    return 'recovery';
  end if;

  if p_event_type = 'restart_count_increased' then
    return 'warning';
  end if;

  -- on-demand（Issue #184 P1）: State は常に正常。稼働の良し悪しは
  -- Health / ExitCode で running と同格に判定する。starting は P3 の
  -- 猶予対象なのでここでは info（Signal 化は reconcile が担う）。
  if p_expected_state = 'on-demand' then
    if p_event_type = 'health_changed' then
      if p_to_value = 'unhealthy' then
        return 'critical';
      end if;
      if p_to_value = 'unknown' then
        return 'warning';
      end if;
      return 'info';
    end if;
    if p_event_type = 'exit_code_changed' then
      if p_to_value is not null
         and p_to_value ~ '^-?[0-9]+$'
         and p_to_value::bigint <> 0 then
        return 'critical';
      end if;
      return 'info';
    end if;
    return 'info';
  end if;

  if p_expected_state = 'stopped' then
    if p_event_type = 'state_changed' and p_to_value = 'running' then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_expected_state = 'absent' then
    if p_event_type = 'state_changed' and p_to_value = 'not_found' then
      return 'info';
    end if;
    if p_event_type = 'state_changed' then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_event_type = 'health_changed' then
    if p_to_value = 'unhealthy' then
      return 'critical';
    end if;
    if p_to_value in ('starting', 'unknown') then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_event_type = 'state_changed' then
    if p_to_value in ('dead', 'exited', 'not_found', 'removing', 'unknown') then
      return 'critical';
    end if;
    if p_to_value in ('restarting', 'paused', 'created') then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_event_type = 'exit_code_changed' then
    if p_to_value is not null
       and p_to_value ~ '^-?[0-9]+$'
       and p_to_value::bigint <> 0 then
      return 'critical';
    end if;
  end if;

  return 'info';
end;
$$;

comment on function public.classify_container_monitoring_event_v2(
  text, text, text, text, bigint, boolean
) is 'Container監視イベントのSeverity分類。Maintenanceとstopped/absentの非対象SignalではopenerのないRecoveryを生成しない。on-demandはStateを常に正常とし、稼働中Healthをrunning同格に扱う（Issue #184 P1）';

-- =====================================================================
-- P3: event 経路では health=starting を Signal 化しない
--   016 の現行定義を基に、state/health/exit ブロックの先頭へ
--   starting の早期 return を追加する。それ以外は変更しない。
--   monitoring_events 自体は従来どおり warning で記録されるため、
--   タイムラインと Incident 側の見え方は変わらない。
-- =====================================================================

create or replace function public.notification_monitoring_event_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_server_id text;
  v_signal_key text;
  v_entity_key text;
  v_signal_type text;
  v_title text;
  v_reason text;
  v_active boolean;
  v_is_recovery boolean := false;
  v_severity text;
  v_detail_href text;
begin
  select hosts.server_id into v_server_id
  from public.hosts as hosts
  where hosts.id = new.host_id;

  if v_server_id is null then
    return new;
  end if;

  v_entity_key := new.host_id::text || ':' || new.container_name;
  v_detail_href := '/containers/' || v_server_id || '/' || new.container_name || '?range=24h';

  if new.event_type in ('state_changed', 'health_changed', 'exit_code_changed') then
    -- P3（Issue #184）: health=starting は 300 秒の猶予を超えた場合のみ
    -- Signal 化する。時間条件は event 経路では判定できないため、starting
    -- への遷移では Signal を適用せず、reconcile が継続時間を見て立てる。
    -- healthy への遷移（復旧）は従来どおりこの経路で閉じる。
    if new.event_type = 'health_changed' and new.to_value = 'starting' then
      return new;
    end if;

    v_signal_type := new.event_type;
    v_signal_key := 'container:' || v_entity_key || ':' || new.event_type;
    v_title := new.container_name || ' / ' || case new.event_type
      when 'state_changed' then 'State'
      when 'health_changed' then 'Health'
      else 'ExitCode'
    end;
    v_reason := case new.event_type
      when 'state_changed' then 'State ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown')
      when 'health_changed' then 'Health ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown')
      else 'ExitCode ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown')
    end;

    if new.severity in ('warning', 'critical') then
      v_active := true;
      v_severity := new.severity;
    else
      if new.severity = 'recovery' then
        v_is_recovery := true;
      elsif new.event_type = 'health_changed' and new.to_value = 'healthy' then
        v_is_recovery := true;
      elsif new.event_type = 'exit_code_changed' and new.to_value ~ '^-?[0-9]+$' and new.to_value::integer = 0 then
        v_is_recovery := true;
      elsif new.event_type = 'state_changed' then
        v_is_recovery := (
          (new.expected_state = 'stopped' and new.to_value in ('exited', 'created'))
          or (new.expected_state = 'absent' and new.to_value = 'not_found')
          or (coalesce(new.expected_state, 'running') not in ('stopped', 'absent') and new.to_value = 'running')
        );
      end if;
      v_active := not v_is_recovery;
      v_severity := 'warning';
    end if;

    if new.severity in ('warning', 'critical') or v_is_recovery then
      perform public.apply_notification_signal_v1(
        v_signal_key,
        'container',
        new.host_id,
        v_server_id,
        'container',
        v_entity_key,
        new.container_name,
        v_signal_type,
        v_active,
        v_severity,
        new.occurred_at,
        v_reason,
        v_title,
        v_detail_href
      );
    end if;
  elsif new.event_type = 'oom_killed' then
    perform public.enqueue_notification_v1(
      'monitoring-event:' || new.id::text,
      null,
      'container',
      new.host_id,
      v_server_id,
      'container',
      v_entity_key,
      new.container_name,
      'event',
      'critical',
      new.container_name || ' / OOMKilled',
      'OOMKilledを検知しました',
      v_detail_href,
      new.occurred_at
    );
  elsif new.event_type = 'restart_count_increased' then
    perform public.enqueue_notification_v1(
      'monitoring-event:' || new.id::text,
      null,
      'container',
      new.host_id,
      v_server_id,
      'container',
      v_entity_key,
      new.container_name,
      'event',
      'warning',
      new.container_name || ' / Restart',
      'RestartCount ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown'),
      v_detail_href,
      new.occurred_at
    );
  end if;

  return new;
end;
$$;

-- =====================================================================
-- P1 / P2 / P3: reconcile の再定義
--   019 の現行定義を基に、次を変更する。それ以外は変更しない。
--   - State の active / severity を共通関数
--     notification_container_state_violation_v1 で決める（P2）
--   - Health に on-demand の扱い（稼働中のみ評価）を追加（P1）
--   - Health starting は container_samples の連続区間が 300 秒を
--     超えた場合のみ warning とする（P3）
--   - cron.schedule は付けない（PG17 には pg_cron が無い。起動は
--     deploy/systemd の ivrm-dash-minutely が毎分この関数を呼ぶ）
-- =====================================================================

create or replace function public.reconcile_notification_container_signals_v1()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_container record;
  v_expected_state text;
  v_entity_key text;
  v_detail_href text;
  v_state_active boolean;
  v_state_severity text;
  v_health_active boolean;
  v_health_severity text;
  v_starting_since timestamptz;
  v_count integer := 0;
begin
  for v_container in
    select distinct on (samples.host_id, samples.container_name)
      samples.host_id,
      hosts.server_id,
      samples.container_name,
      samples.received_at,
      samples.state,
      samples.health,
      expectations.expected_state
    from public.container_samples as samples
    join public.hosts as hosts
      on hosts.id = samples.host_id
     and hosts.enabled
    left join public.container_expectations as expectations
      on expectations.host_id = samples.host_id
     and expectations.container_name = samples.container_name
    where samples.received_at >= v_now - interval '45 seconds'
    order by samples.host_id, samples.container_name, samples.received_at desc, samples.id desc
  loop
    v_expected_state := coalesce(v_container.expected_state, 'running');
    v_entity_key := v_container.host_id::text || ':' || v_container.container_name;
    v_detail_href := '/containers/' || v_container.server_id || '/' || v_container.container_name || '?range=24h';

    -- P2: State の写像は分類器と共通の関数で決める
    v_state_severity := public.notification_container_state_violation_v1(
      v_expected_state,
      v_container.state
    );
    v_state_active := v_state_severity is not null;

    perform public.apply_notification_signal_v1(
      'container:' || v_entity_key || ':state_changed',
      'container',
      v_container.host_id,
      v_container.server_id,
      'container',
      v_entity_key,
      v_container.container_name,
      'state_changed',
      v_state_active,
      coalesce(v_state_severity, 'warning'),
      v_container.received_at,
      case
        when v_state_active then '現在Stateが期待状態と一致しません: ' || v_container.state || ' / expected=' || v_expected_state
        else '現在Stateは期待状態と一致しています: ' || v_container.state
      end,
      v_container.container_name || ' / State',
      v_detail_href
    );

    -- P3: starting の継続開始時刻。直前の「starting でも running でもない」
    -- サンプルより後ろで、health=starting かつ state=running の連続区間の
    -- 先頭サンプル時刻とする。サンプルが途切れた場合は区間が短く見積もられ、
    -- 通知が遅れる方向（安全側）に倒れる。
    v_starting_since := null;
    if v_container.health = 'starting' and v_container.state = 'running' then
      select min(samples.received_at)
      into v_starting_since
      from public.container_samples as samples
      where samples.host_id = v_container.host_id
        and samples.container_name = v_container.container_name
        and samples.health = 'starting'
        and samples.state = 'running'
        and samples.received_at > coalesce((
          select max(prev.received_at)
          from public.container_samples as prev
          where prev.host_id = v_container.host_id
            and prev.container_name = v_container.container_name
            and (prev.health is distinct from 'starting'
                 or prev.state is distinct from 'running')
        ), '-infinity'::timestamptz);
    end if;

    v_health_severity := case
      when v_expected_state in ('stopped', 'absent') then null
      -- P1: on-demand の Health は稼働中のみ running と同格に評価する
      when v_expected_state = 'on-demand' and v_container.state <> 'running' then null
      when v_container.health = 'unhealthy' then 'critical'
      when v_container.health = 'unknown' then 'warning'
      when v_container.health = 'starting'
        and v_starting_since is not null
        and v_now - v_starting_since >= interval '300 seconds' then 'warning'
      else null
    end;
    v_health_active := v_health_severity is not null;

    perform public.apply_notification_signal_v1(
      'container:' || v_entity_key || ':health_changed',
      'container',
      v_container.host_id,
      v_container.server_id,
      'container',
      v_entity_key,
      v_container.container_name,
      'health_changed',
      v_health_active,
      coalesce(v_health_severity, 'warning'),
      v_container.received_at,
      case
        when v_health_active then '現在Healthが通知対象です: ' || v_container.health
        else '現在Healthは通知対象外です: ' || v_container.health
      end,
      v_container.container_name || ' / Health',
      v_detail_href
    );

    if v_state_active or v_health_active then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

comment on function public.reconcile_notification_container_signals_v1() is
  '最新45秒以内のContainer SnapshotからState / Healthの現在異常を再評価し、Notification導入前から継続する異常もSignalへ同期する。古いSnapshotはHost Heartbeat Signalに委ねる。State写像は分類器と共通化し、health=startingは300秒継続した場合のみ対象とする（Issue #184 P1/P2/P3）';

-- =====================================================================
-- P1: mc-resource の期待状態を on-demand へ移行
--   auto-scale（接続時起動・無人30分で自動停止）が設計どおりの対象。
--   現在 stopped の行だけを対象にし、手動で別値へ変えられていた場合は
--   触らない（冪等）。
-- =====================================================================

update public.container_expectations as expectations
set expected_state = 'on-demand'
from public.hosts as hosts
where hosts.id = expectations.host_id
  and hosts.server_id = 'oci-minecraft-01'
  and expectations.container_name = 'mc-resource'
  and expectations.expected_state = 'stopped';
