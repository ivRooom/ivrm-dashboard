alter table public.hosts drop constraint if exists hosts_server_id_format_check;
alter table public.hosts add constraint hosts_server_id_format_check check (
  server_id ~ '^[A-Za-z0-9._-]{1,64}$'
  and server_id !~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
);

create table if not exists public.host_monitoring_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  host_id uuid not null references public.hosts(id) on delete cascade,
  occurred_at timestamptz not null,
  event_type text not null,
  severity text not null,
  from_value text,
  to_value text,
  numeric_value bigint,
  heartbeat_id bigint references public.agent_heartbeats(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  constraint host_monitoring_events_key_check check (char_length(event_key) between 1 and 256),
  constraint host_monitoring_events_type_check check (
    event_type in ('host_reboot_detected','agent_version_changed','heartbeat_gap_detected')
  ),
  constraint host_monitoring_events_severity_check check (severity in ('info','warning')),
  constraint host_monitoring_events_from_check check (from_value is null or char_length(from_value) <= 128),
  constraint host_monitoring_events_to_check check (to_value is null or char_length(to_value) <= 128),
  constraint host_monitoring_events_numeric_check check (numeric_value is null or numeric_value >= 0)
);

create index if not exists host_monitoring_events_time_idx
  on public.host_monitoring_events (occurred_at desc, id desc);
create index if not exists host_monitoring_events_host_time_idx
  on public.host_monitoring_events (host_id, occurred_at desc, id desc);

alter table public.host_monitoring_events enable row level security;
alter table public.host_monitoring_events force row level security;
revoke all on table public.host_monitoring_events from public, anon, authenticated, service_role;
revoke all on sequence public.host_monitoring_events_id_seq from public, anon, authenticated, service_role;

drop policy if exists "deny_host_monitoring_events_public_access" on public.host_monitoring_events;
create policy "deny_host_monitoring_events_public_access"
on public.host_monitoring_events
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

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

  v_gap_seconds := greatest(0, floor(extract(epoch from (new.received_at-v_previous.received_at)))::bigint);
  if v_gap_seconds > 180 then
    insert into public.host_monitoring_events
      (event_key,host_id,occurred_at,event_type,severity,numeric_value,heartbeat_id)
    values
      ('heartbeat:'||new.id||':gap',new.host_id,new.received_at,
       'heartbeat_gap_detected','warning',v_gap_seconds,new.id)
    on conflict (event_key) do nothing;
  end if;

  if new.uptime_seconds + 60 < v_previous.uptime_seconds then
    v_uptime_drop := greatest(0, floor(v_previous.uptime_seconds-new.uptime_seconds)::bigint);
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

drop trigger if exists capture_host_monitoring_events_after_insert on public.agent_heartbeats;
create trigger capture_host_monitoring_events_after_insert
after insert on public.agent_heartbeats
for each row execute function public.capture_host_monitoring_events();

with ordered as (
  select
    heartbeat.id,heartbeat.host_id,heartbeat.received_at,heartbeat.agent_version,heartbeat.uptime_seconds,
    lag(heartbeat.id) over w as prev_id,
    lag(heartbeat.received_at) over w as prev_received_at,
    lag(heartbeat.agent_version) over w as prev_agent_version,
    lag(heartbeat.uptime_seconds) over w as prev_uptime_seconds
  from public.agent_heartbeats as heartbeat
  window w as (partition by heartbeat.host_id order by heartbeat.received_at,heartbeat.id)
), event_rows as (
  select
    'heartbeat:'||id||':agent-version' event_key,host_id,received_at occurred_at,
    'agent_version_changed'::text event_type,'info'::text severity,
    prev_agent_version::text from_value,agent_version::text to_value,null::bigint numeric_value,id heartbeat_id
  from ordered
  where prev_id is not null and agent_version is distinct from prev_agent_version

  union all

  select
    'heartbeat:'||id||':gap',host_id,received_at,'heartbeat_gap_detected','warning',
    null::text,null::text,
    greatest(0,floor(extract(epoch from (received_at-prev_received_at)))::bigint),id
  from ordered
  where prev_id is not null
    and floor(extract(epoch from (received_at-prev_received_at)))::bigint > 180

  union all

  select
    'heartbeat:'||id||':reboot',host_id,received_at,'host_reboot_detected','warning',
    floor(prev_uptime_seconds)::bigint::text,floor(uptime_seconds)::bigint::text,
    greatest(0,floor(prev_uptime_seconds-uptime_seconds)::bigint),id
  from ordered
  where prev_id is not null and uptime_seconds + 60 < prev_uptime_seconds
)
insert into public.host_monitoring_events
  (event_key,host_id,occurred_at,event_type,severity,from_value,to_value,numeric_value,heartbeat_id)
select event_key,host_id,occurred_at,event_type,severity,from_value,to_value,numeric_value,heartbeat_id
from event_rows
on conflict (event_key) do nothing;

create or replace function public.get_host_monitoring_events_v2(
  p_range text,
  p_server_id text default null,
  p_before_at timestamptz default null,
  p_before_id bigint default null,
  p_limit integer default 500
)
returns table (
  event_id bigint,
  host_id uuid,
  server_id text,
  host_display_name text,
  occurred_at timestamptz,
  event_type text,
  severity text,
  from_value text,
  to_value text,
  numeric_value bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_interval interval;
  v_limit integer;
begin
  v_interval := case p_range
    when '1h' then interval '1 hour'
    when '6h' then interval '6 hours'
    when '24h' then interval '24 hours'
    when '7d' then interval '7 days'
    when '30d' then interval '30 days'
    else null
  end;
  if v_interval is null then raise exception 'invalid range'; end if;

  if p_server_id is not null and (
    char_length(p_server_id) < 1 or char_length(p_server_id) > 64
    or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
    or p_server_id ~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
  ) then raise exception 'invalid server id'; end if;

  if (p_before_at is null) <> (p_before_id is null) then
    raise exception 'invalid cursor';
  end if;

  v_limit := least(greatest(coalesce(p_limit,500),1),500);

  return query
  select events.id,events.host_id,hosts.server_id,hosts.display_name,
    events.occurred_at,events.event_type,events.severity,
    events.from_value,events.to_value,events.numeric_value
  from public.host_monitoring_events as events
  join public.hosts as hosts on hosts.id=events.host_id
  where events.occurred_at >= clock_timestamp()-v_interval
    and (p_server_id is null or hosts.server_id=p_server_id)
    and (
      p_before_at is null
      or (events.occurred_at,events.id) < (p_before_at,p_before_id)
    )
  order by events.occurred_at desc,events.id desc
  limit v_limit;
end;
$$;

revoke all on function public.get_host_monitoring_events_v2(text,text,timestamptz,bigint,integer)
  from public, anon, authenticated;
grant execute on function public.get_host_monitoring_events_v2(text,text,timestamptz,bigint,integer)
  to service_role;
