-- 既存環境でpgcryptoがpublic等へ入っていても、後続Migration 020のSchema参照を安定させる。
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter extension pgcrypto set schema extensions;

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

    v_state_active := case v_expected_state
      when 'stopped' then v_container.state not in ('exited', 'created')
      when 'absent' then v_container.state <> 'not_found'
      else v_container.state <> 'running'
    end;

    v_state_severity := case
      when not v_state_active then 'warning'
      when v_expected_state = 'running' and v_container.state in ('restarting', 'paused') then 'warning'
      else 'critical'
    end;

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
      v_state_severity,
      v_container.received_at,
      case
        when v_state_active then '現在Stateが期待状態と一致しません: ' || v_container.state || ' / expected=' || v_expected_state
        else '現在Stateは期待状態と一致しています: ' || v_container.state
      end,
      v_container.container_name || ' / State',
      v_detail_href
    );

    v_health_active := case
      when v_expected_state in ('stopped', 'absent') then false
      when v_expected_state = 'running' then v_container.health in ('unhealthy', 'starting', 'unknown')
      else v_container.health in ('unhealthy', 'starting')
    end;

    v_health_severity := case
      when not v_health_active then 'warning'
      when v_container.health = 'unhealthy' then 'critical'
      else 'warning'
    end;

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
      v_health_severity,
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

select cron.schedule(
  'ivrm-notification-container-reconcile-v1',
  '* * * * *',
  $cron$select public.reconcile_notification_container_signals_v1();$cron$
);

revoke all on function public.reconcile_notification_container_signals_v1()
  from public, anon, authenticated;
grant execute on function public.reconcile_notification_container_signals_v1()
  to service_role;

comment on function public.reconcile_notification_container_signals_v1() is
  '最新45秒以内のContainer SnapshotからState / Healthの現在異常を再評価し、Notification導入前から継続する異常もSignalへ同期する。古いSnapshotはHost Heartbeat Signalに委ねる。';
