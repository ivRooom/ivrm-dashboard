-- Incident Center review follow-up:
-- Maintenance内だけで発生・復旧したTransitionをrecoveryとして数えない。
-- genuineなMaintenance前IncidentはWeb側の値ベースResolverで解消する。

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

  -- OOMはMaintenance中でも見逃さない。
  if p_event_type = 'oom_killed' then
    return 'critical';
  end if;

  -- Maintenance中のState / Health / ExitCode / Restartはすべてinfoに保つ。
  -- 既に開いているIncidentの解消はWeb側がto_valueから判断するため、
  -- Maintenance内だけの正常化をRecovery件数へ混入させない。
  if p_maintenance_active then
    return 'info';
  end if;

  if p_event_type = 'health_changed'
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

revoke all on function public.classify_container_monitoring_event_v2(
  text, text, text, text, bigint, boolean
) from public, anon, authenticated, service_role;

-- Migration 008でMaintenance中の正常化をrecoveryへ補正した行を、
-- 直前のMaintenanceイベントがstartedである場合だけinfoへ戻す。
-- Maintenance前から開いていたIncidentもWeb側の値ベースResolverで正しく閉じる。
with maintenance_recoveries as (
  select events.id
  from public.monitoring_events as events
  where events.severity = 'recovery'
    and (
      (
        events.event_type = 'health_changed'
        and events.to_value = 'healthy'
      )
      or (
        events.event_type = 'state_changed'
        and events.expected_state is distinct from 'stopped'
        and events.expected_state is distinct from 'absent'
        and events.to_value = 'running'
      )
      or (
        events.event_type = 'exit_code_changed'
        and events.to_value is not null
        and events.to_value ~ '^-?[0-9]+$'
        and events.to_value::bigint = 0
      )
    )
    and (
      select maintenance.event_type
      from public.monitoring_events as maintenance
      where maintenance.host_id = events.host_id
        and maintenance.container_name = events.container_name
        and maintenance.event_type in ('maintenance_started', 'maintenance_ended')
        and (
          maintenance.occurred_at < events.occurred_at
          or (
            maintenance.occurred_at = events.occurred_at
            and maintenance.id < events.id
          )
        )
      order by maintenance.occurred_at desc, maintenance.id desc
      limit 1
    ) = 'maintenance_started'
)
update public.monitoring_events as events
set severity = 'info'
from maintenance_recoveries
where events.id = maintenance_recoveries.id;

comment on function public.classify_container_monitoring_event_v2(
  text, text, text, text, bigint, boolean
) is 'Container監視イベントのSeverity分類。Maintenance内TransitionはOOM以外infoとし、既存Incidentの値ベース解消はWeb reducerへ委譲する';
