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
        when events.event_type = 'state_changed'
          and events.expected_state = 'stopped'
          and events.to_value in ('exited', 'created') then true
        when events.event_type = 'state_changed'
          and events.expected_state = 'absent'
          and events.to_value = 'not_found' then true
        else false
      end as resolves_signal,
      events.severity in ('warning', 'critical') as opens_signal
    from public.monitoring_events as events
    join public.hosts as hosts on hosts.id = events.host_id
    where events.occurred_at < p_before_at
      and events.event_type in ('state_changed', 'health_changed', 'exit_code_changed')
  ), latest_resolver as (
    select distinct on (normalized.host_id, normalized.container_name, normalized.signal_name)
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
    select distinct on (open_candidates.host_id, open_candidates.container_name, open_candidates.signal_name)
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

comment on function public.get_monitoring_incident_context_v1(timestamptz) is
  'Incident期間境界より前から継続する未解決State/Health/ExitCodeシグナルの正確な開始イベントを返すService Role専用RPC';
