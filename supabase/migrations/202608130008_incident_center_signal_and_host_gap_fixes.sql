-- Incident Center review follow-up:
-- 1. Maintenance中に正常値へ戻ったState/Health/ExitCodeもSignalを解消できるようにする。
-- 2. HostのActive stale閾値(45秒)とHeartbeat gapイベント生成閾値を揃える。
-- 3. Recovered Host Incidentで46-180秒のstaleと180秒超のofflineを区別できる履歴を補完する。

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

  -- Incident開始後にMaintenanceへ入っても、正常値への復帰は必ず
  -- recoveryとして残す。これにより健康な期間を跨いでIncidentを結合しない。
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

  -- 計画Maintenance中の新規停止・Health変化・Restart等はIncident扱いしない。
  if p_maintenance_active then
    return 'info';
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

-- 既存のMaintenance中infoイベントでも、値だけで正常復帰を証明できるものは
-- recoveryへ補正する。stopped/absentのState復帰はWeb側がinfoでも解消可能。
update public.monitoring_events
set severity = 'recovery'
where severity = 'info'
  and (
    (
      event_type = 'health_changed'
      and to_value = 'healthy'
      and from_value in ('unhealthy', 'starting', 'unknown')
    )
    or (
      event_type = 'state_changed'
      and expected_state is distinct from 'stopped'
      and expected_state is distinct from 'absent'
      and to_value = 'running'
      and from_value is distinct from 'running'
    )
    or (
      event_type = 'exit_code_changed'
      and from_value is not null
      and from_value ~ '^-?[0-9]+$'
      and from_value::bigint <> 0
      and to_value is not null
      and to_value ~ '^-?[0-9]+$'
      and to_value::bigint = 0
    )
  );

create or replace function public.capture_host_monitoring_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous public.agent_heartbeats%rowtype;
  v_gap_seconds bigint;
  v_uptime_drop bigint;
begin
  select heartbeat.* into v_previous
  from public.agent_heartbeats as heartbeat
  where heartbeat.host_id = new.host_id
    and heartbeat.id <> new.id
    and (
      heartbeat.received_at < new.received_at
      or (heartbeat.received_at = new.received_at and heartbeat.id < new.id)
    )
  order by heartbeat.received_at desc, heartbeat.id desc
  limit 1;

  if not found then return new; end if;

  if new.agent_version is distinct from v_previous.agent_version then
    insert into public.host_monitoring_events
      (event_key,host_id,occurred_at,event_type,severity,from_value,to_value,heartbeat_id)
    values
      ('heartbeat:'||new.id||':agent-version',new.host_id,new.received_at,
       'agent_version_changed','info',v_previous.agent_version,new.agent_version,new.id)
    on conflict (event_key) do nothing;
  end if;

  v_gap_seconds := greatest(
    0,
    floor(extract(epoch from (new.received_at-v_previous.received_at)))::bigint
  );
  if v_gap_seconds > 45 then
    insert into public.host_monitoring_events
      (event_key,host_id,occurred_at,event_type,severity,numeric_value,heartbeat_id)
    values
      ('heartbeat:'||new.id||':gap',new.host_id,new.received_at,
       'heartbeat_gap_detected','warning',v_gap_seconds,new.id)
    on conflict (event_key) do nothing;
  end if;

  if new.uptime_seconds + 60 < v_previous.uptime_seconds then
    v_uptime_drop := greatest(
      0,
      floor(v_previous.uptime_seconds-new.uptime_seconds)::bigint
    );
    insert into public.host_monitoring_events
      (event_key,host_id,occurred_at,event_type,severity,from_value,to_value,numeric_value,heartbeat_id)
    values
      ('heartbeat:'||new.id||':reboot',new.host_id,new.received_at,
       'host_reboot_detected','warning',
       floor(v_previous.uptime_seconds)::bigint::text,
       floor(new.uptime_seconds)::bigint::text,
       v_uptime_drop,new.id)
    on conflict (event_key) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.capture_host_monitoring_events()
  from public, anon, authenticated, service_role;

-- 旧180秒閾値で欠落した46-180秒のHost gapも同じevent_keyで冪等Backfillする。
with ordered as (
  select
    heartbeat.id,
    heartbeat.host_id,
    heartbeat.received_at,
    lag(heartbeat.id) over w as prev_id,
    lag(heartbeat.received_at) over w as prev_received_at
  from public.agent_heartbeats as heartbeat
  window w as (
    partition by heartbeat.host_id
    order by heartbeat.received_at, heartbeat.id
  )
)
insert into public.host_monitoring_events (
  event_key,
  host_id,
  occurred_at,
  event_type,
  severity,
  numeric_value,
  heartbeat_id
)
select
  'heartbeat:'||id||':gap',
  host_id,
  received_at,
  'heartbeat_gap_detected',
  'warning',
  greatest(
    0,
    floor(extract(epoch from (received_at-prev_received_at)))::bigint
  ),
  id
from ordered
where prev_id is not null
  and floor(extract(epoch from (received_at-prev_received_at)))::bigint > 45
on conflict (event_key) do nothing;

create or replace function public.get_monitoring_incident_context_v1(
  p_before_at timestamptz
)
returns table (
  event_id bigint,
  host_id uuid,
  server_id text,
  host_display_name text,
  container_name text,
  occurred_at timestamptz,
  event_type text,
  severity text,
  from_value text,
  to_value text,
  numeric_value bigint,
  expected_state text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_before_at is null
     or p_before_at > clock_timestamp() + interval '5 minutes'
     or p_before_at < clock_timestamp() - interval '31 days' then
    raise exception 'invalid context boundary';
  end if;

  return query
  with normalized as (
    select
      events.id,
      events.host_id,
      hosts.server_id,
      hosts.display_name,
      events.container_name,
      events.occurred_at,
      events.event_type,
      events.severity,
      events.from_value,
      events.to_value,
      events.numeric_value,
      events.expected_state,
      case events.event_type
        when 'state_changed' then 'state'
        when 'health_changed' then 'health'
        when 'exit_code_changed' then 'exit'
        else null
      end as signal_name,
      case
        when events.severity = 'recovery' then true
        when events.event_type = 'health_changed'
          and events.to_value = 'healthy' then true
        when events.event_type = 'exit_code_changed'
          and events.to_value is not null
          and events.to_value ~ '^-?[0-9]+$'
          and events.to_value::bigint = 0 then true
        when events.event_type = 'state_changed'
          and events.expected_state = 'stopped'
          and events.to_value in ('exited', 'created') then true
        when events.event_type = 'state_changed'
          and events.expected_state = 'absent'
          and events.to_value = 'not_found' then true
        when events.event_type = 'state_changed'
          and events.expected_state is distinct from 'stopped'
          and events.expected_state is distinct from 'absent'
          and events.to_value = 'running' then true
        else false
      end as resolves_signal,
      events.severity in ('warning', 'critical') as opens_signal
    from public.monitoring_events as events
    join public.hosts as hosts on hosts.id = events.host_id
    where events.occurred_at < p_before_at
      and events.event_type in ('state_changed', 'health_changed', 'exit_code_changed')
  ), latest_resolver as (
    select distinct on (
      normalized.host_id,
      normalized.container_name,
      normalized.signal_name
    )
      normalized.host_id,
      normalized.container_name,
      normalized.signal_name,
      normalized.occurred_at,
      normalized.id
    from normalized
    where normalized.resolves_signal
    order by
      normalized.host_id,
      normalized.container_name,
      normalized.signal_name,
      normalized.occurred_at desc,
      normalized.id desc
  ), open_candidates as (
    select normalized.*
    from normalized
    left join latest_resolver
      on latest_resolver.host_id = normalized.host_id
     and latest_resolver.container_name = normalized.container_name
     and latest_resolver.signal_name = normalized.signal_name
    where normalized.opens_signal
      and (
        latest_resolver.id is null
        or normalized.occurred_at > latest_resolver.occurred_at
        or (
          normalized.occurred_at = latest_resolver.occurred_at
          and normalized.id > latest_resolver.id
        )
      )
  ), first_open as (
    select distinct on (
      open_candidates.host_id,
      open_candidates.container_name,
      open_candidates.signal_name
    )
      open_candidates.*
    from open_candidates
    order by
      open_candidates.host_id,
      open_candidates.container_name,
      open_candidates.signal_name,
      open_candidates.occurred_at,
      open_candidates.id
  )
  select
    first_open.id,
    first_open.host_id,
    first_open.server_id,
    first_open.display_name,
    first_open.container_name,
    first_open.occurred_at,
    first_open.event_type,
    first_open.severity,
    first_open.from_value,
    first_open.to_value,
    first_open.numeric_value,
    first_open.expected_state
  from first_open
  order by first_open.occurred_at, first_open.id;
end;
$$;

revoke all on function public.get_monitoring_incident_context_v1(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_monitoring_incident_context_v1(timestamptz)
  to service_role;

comment on function public.capture_host_monitoring_events() is
  'Host Heartbeat差分を監視イベントへ変換し、45秒超のstale gapから記録する内部Trigger';
comment on function public.get_monitoring_incident_context_v1(timestamptz) is
  'Incident期間境界より前から継続する未解決State/Health/ExitCodeシグナルを値ベースの復旧も考慮して返すService Role専用RPC';
