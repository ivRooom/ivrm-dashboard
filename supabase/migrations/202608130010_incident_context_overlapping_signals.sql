-- Incident Center review follow-up:
-- 30日境界より前で複数Signalが重なった連続Incidentについて、
-- 境界時点で未解決のSignal openerだけでなく、連続Episodeの最初の開始まで
-- Context Eventを返して正確なMTTRを維持する。

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
  ), open_with_resolver as (
    select
      opened.*,
      resolver.id as resolver_id,
      resolver.occurred_at as resolver_at
    from normalized as opened
    left join lateral (
      select
        candidate.id,
        candidate.occurred_at
      from normalized as candidate
      where candidate.host_id = opened.host_id
        and candidate.container_name = opened.container_name
        and candidate.signal_name = opened.signal_name
        and candidate.resolves_signal
        and (
          candidate.occurred_at > opened.occurred_at
          or (
            candidate.occurred_at = opened.occurred_at
            and candidate.id > opened.id
          )
        )
      order by candidate.occurred_at, candidate.id
      limit 1
    ) as resolver on true
    where opened.opens_signal
  ), signal_episodes as (
    select distinct on (
      opened.host_id,
      opened.container_name,
      opened.signal_name,
      coalesce(opened.resolver_id, -1)
    )
      opened.host_id,
      opened.container_name,
      opened.signal_name,
      opened.id as start_event_id,
      opened.occurred_at as started_at,
      opened.resolver_id,
      opened.resolver_at
    from open_with_resolver as opened
    order by
      opened.host_id,
      opened.container_name,
      opened.signal_name,
      coalesce(opened.resolver_id, -1),
      opened.occurred_at,
      opened.id
  ), episode_ordered as (
    select
      episode.*,
      max(coalesce(episode.resolver_at, p_before_at)) over (
        partition by episode.host_id, episode.container_name
        order by episode.started_at, episode.start_event_id
        rows between unbounded preceding and 1 preceding
      ) as previous_max_end
    from signal_episodes as episode
  ), episode_marked as (
    select
      episode_ordered.*,
      case
        when episode_ordered.previous_max_end is null
          or episode_ordered.started_at > episode_ordered.previous_max_end
        then 1
        else 0
      end as component_start
    from episode_ordered
  ), episode_componented as (
    select
      episode_marked.*,
      sum(episode_marked.component_start) over (
        partition by episode_marked.host_id, episode_marked.container_name
        order by episode_marked.started_at, episode_marked.start_event_id
        rows between unbounded preceding and current row
      ) as component_id
    from episode_marked
  ), active_component_ids as (
    select
      episode_componented.host_id,
      episode_componented.container_name,
      episode_componented.component_id
    from episode_componented
    group by
      episode_componented.host_id,
      episode_componented.container_name,
      episode_componented.component_id
    having bool_or(episode_componented.resolver_id is null)
  ), active_component_starts as (
    select distinct on (
      episode_componented.host_id,
      episode_componented.container_name,
      episode_componented.component_id
    )
      episode_componented.host_id,
      episode_componented.container_name,
      episode_componented.component_id,
      episode_componented.started_at,
      episode_componented.start_event_id
    from episode_componented
    join active_component_ids
      on active_component_ids.host_id = episode_componented.host_id
     and active_component_ids.container_name = episode_componented.container_name
     and active_component_ids.component_id = episode_componented.component_id
    order by
      episode_componented.host_id,
      episode_componented.container_name,
      episode_componented.component_id,
      episode_componented.started_at,
      episode_componented.start_event_id
  )
  select
    normalized.id,
    normalized.host_id,
    normalized.server_id,
    normalized.display_name,
    normalized.container_name,
    normalized.occurred_at,
    normalized.event_type,
    normalized.severity,
    normalized.from_value,
    normalized.to_value,
    normalized.numeric_value,
    normalized.expected_state
  from normalized
  join active_component_starts
    on active_component_starts.host_id = normalized.host_id
   and active_component_starts.container_name = normalized.container_name
  where (
    normalized.occurred_at > active_component_starts.started_at
    or (
      normalized.occurred_at = active_component_starts.started_at
      and normalized.id >= active_component_starts.start_event_id
    )
  )
  order by normalized.occurred_at, normalized.id;
end;
$$;

revoke all on function public.get_monitoring_incident_context_v1(timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.get_monitoring_incident_context_v1(timestamptz)
  to service_role;

comment on function public.get_monitoring_incident_context_v1(timestamptz) is
  'Incident期間境界より前から継続するState/Health/ExitCodeの連続Episodeを、重複Signalの開始・復旧を含めて再生できるContext Event列として返すService Role専用RPC';
