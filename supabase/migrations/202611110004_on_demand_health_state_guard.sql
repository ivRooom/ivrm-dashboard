-- Issue #184 是正スライス追補: on-demand の Health 判定を「state='running' の間だけ」に揃える
--
-- 実地確認（2026-11-11 19:59、mc-resource の計画停止）で判明した不整合:
--   停止したコンテナの health は Docker 側で最後の値（unhealthy）に凍結される。
--   capture は state='exited' と health healthy→unhealthy の同時遷移から
--   health_changed イベントを作り、分類器（on-demand は running 同格）が
--   critical を立ててしまう。reconcile は「state != running の Health は対象外」
--   として直後に復旧させるため、結果として 発生→復旧 のノイズペアが配送された
--   （outbox id 305/306、どちらも sent）。
--   reconcile と同じ規則を、サンプルの state を知っている capture 側でも適用する。
--
-- 対象は on-demand のみ。running / stopped / absent の分類は変更しない。
-- exit_code_changed は対象外（異常終了の検知は state='exited' のサンプルで
--   正しく発火すべきものなので、ここに running 条件を付けてはいけない）。
-- 適用先: PG17 の ivrm_dashboard。CREATE OR REPLACE のため owner / ACL は保持される。

create or replace function public.capture_container_monitoring_events()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_previous public.container_samples%rowtype;
  v_expected_state text;
  v_maintenance_mode boolean := false;
  v_maintenance_until timestamptz;
  v_maintenance_active boolean := false;
  v_severity text;
begin
  select samples.* into v_previous
  from public.container_samples samples
  where samples.host_id=new.host_id
    and samples.container_name=new.container_name
    and samples.received_at < new.received_at
    and samples.id <> new.id
  order by samples.received_at desc,samples.id desc
  limit 1;
  if not found then return new; end if;

  select expectations.expected_state,expectations.maintenance_mode,expectations.maintenance_until
    into v_expected_state,v_maintenance_mode,v_maintenance_until
  from public.container_expectations expectations
  where expectations.host_id=new.host_id and expectations.container_name=new.container_name;

  v_maintenance_active := coalesce(v_maintenance_mode,false)
    and (v_maintenance_until is null or v_maintenance_until > new.received_at);

  if new.state is distinct from v_previous.state then
    v_severity := public.classify_container_monitoring_event_v2(v_expected_state,'state_changed',v_previous.state,new.state,null,v_maintenance_active);
    insert into public.monitoring_events(event_key,host_id,container_name,occurred_at,event_type,severity,from_value,to_value,expected_state,sample_id)
    values('sample:'||new.id||':state',new.host_id,new.container_name,new.received_at,'state_changed',v_severity,v_previous.state,new.state,v_expected_state,new.id)
    on conflict(event_key) do nothing;
  end if;
  if new.health is distinct from v_previous.health then
    v_severity := public.classify_container_monitoring_event_v2(v_expected_state,'health_changed',v_previous.health,new.health,null,v_maintenance_active);
    -- Issue #184: on-demand の Health は稼働中（state='running'）だけが判定対象。
    -- 停止中のサンプルに残る凍結した health で Signal を立てない（reconcile と同じ規則）。
    if v_expected_state = 'on-demand' and new.state is distinct from 'running' then
      v_severity := 'info';
    end if;
    insert into public.monitoring_events(event_key,host_id,container_name,occurred_at,event_type,severity,from_value,to_value,expected_state,sample_id)
    values('sample:'||new.id||':health',new.host_id,new.container_name,new.received_at,'health_changed',v_severity,v_previous.health,new.health,v_expected_state,new.id)
    on conflict(event_key) do nothing;
  end if;
  if new.restart_count > v_previous.restart_count then
    v_severity := public.classify_container_monitoring_event_v2(v_expected_state,'restart_count_increased',v_previous.restart_count::text,new.restart_count::text,(new.restart_count-v_previous.restart_count)::bigint,v_maintenance_active);
    insert into public.monitoring_events(event_key,host_id,container_name,occurred_at,event_type,severity,from_value,to_value,numeric_value,expected_state,sample_id)
    values('sample:'||new.id||':restart',new.host_id,new.container_name,new.received_at,'restart_count_increased',v_severity,v_previous.restart_count::text,new.restart_count::text,(new.restart_count-v_previous.restart_count)::bigint,v_expected_state,new.id)
    on conflict(event_key) do nothing;
  end if;
  if not v_previous.oom_killed and new.oom_killed then
    insert into public.monitoring_events(event_key,host_id,container_name,occurred_at,event_type,severity,from_value,to_value,expected_state,sample_id)
    values('sample:'||new.id||':oom',new.host_id,new.container_name,new.received_at,'oom_killed','critical','false','true',v_expected_state,new.id)
    on conflict(event_key) do nothing;
  end if;
  if new.exit_code is distinct from v_previous.exit_code then
    v_severity := public.classify_container_monitoring_event_v2(v_expected_state,'exit_code_changed',v_previous.exit_code::text,new.exit_code::text,new.exit_code::bigint,v_maintenance_active);
    insert into public.monitoring_events(event_key,host_id,container_name,occurred_at,event_type,severity,from_value,to_value,numeric_value,expected_state,sample_id)
    values('sample:'||new.id||':exit',new.host_id,new.container_name,new.received_at,'exit_code_changed',v_severity,v_previous.exit_code::text,new.exit_code::text,new.exit_code::bigint,v_expected_state,new.id)
    on conflict(event_key) do nothing;
  end if;
  return new;
end;
$function$;
