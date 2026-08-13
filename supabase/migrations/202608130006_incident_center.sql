create or replace function public.get_monitoring_events_v2(
  p_range text,
  p_server_id text default null,
  p_container_name text default null,
  p_severity text default null,
  p_before_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 500
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
declare
  v_interval interval;
begin
  v_interval := case p_range
    when '1h' then interval '1 hour'
    when '6h' then interval '6 hours'
    when '24h' then interval '24 hours'
    when '7d' then interval '7 days'
    when '30d' then interval '30 days'
    else null
  end;

  if v_interval is null then
    raise exception 'invalid range';
  end if;

  if p_server_id is not null and (
    char_length(p_server_id) < 1
    or char_length(p_server_id) > 64
    or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
    or p_server_id ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
  ) then
    raise exception 'invalid server id';
  end if;

  if p_container_name is not null and (
    char_length(p_container_name) < 1
    or char_length(p_container_name) > 128
    or p_container_name !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
  ) then
    raise exception 'invalid container name';
  end if;

  if (p_server_id is null) <> (p_container_name is null) then
    raise exception 'server id and container name must be specified together';
  end if;

  if p_severity is not null
     and p_severity not in ('info', 'warning', 'critical', 'recovery') then
    raise exception 'invalid severity';
  end if;

  if (p_before_at is null) <> (p_before_id is null) then
    raise exception 'invalid cursor';
  end if;

  if p_before_id is not null and p_before_id <= 0 then
    raise exception 'invalid cursor id';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'invalid limit';
  end if;

  return query
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
    events.expected_state
  from public.monitoring_events as events
  join public.hosts as hosts
    on hosts.id = events.host_id
  where events.occurred_at >= clock_timestamp() - v_interval
    and (p_server_id is null or hosts.server_id = p_server_id)
    and (p_container_name is null or events.container_name = p_container_name)
    and (p_severity is null or events.severity = p_severity)
    and (
      p_before_at is null
      or events.occurred_at < p_before_at
      or (events.occurred_at = p_before_at and events.id < p_before_id)
    )
  order by events.occurred_at desc, events.id desc
  limit p_limit;
end;
$$;

revoke all on function public.get_monitoring_events_v1(text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_monitoring_events_v2(
  text, text, text, text, timestamptz, bigint, integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_monitoring_events_v2(
  text, text, text, text, timestamptz, bigint, integer
) to service_role;

comment on function public.get_monitoring_events_v2(
  text, text, text, text, timestamptz, bigint, integer
) is
  '許可済み期間・Host・Container・Severityで監視イベントをKeyset Pagination取得するService Role専用RPC';
