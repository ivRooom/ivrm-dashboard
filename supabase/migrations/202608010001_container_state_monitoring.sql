create table if not exists public.container_samples (
  id bigint generated always as identity primary key,
  heartbeat_id bigint not null references public.agent_heartbeats(id) on delete cascade,
  host_id uuid not null references public.hosts(id) on delete cascade,
  received_at timestamptz not null,
  container_name text not null check (container_name ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'),
  state text not null check (
    state in ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown', 'not_found')
  ),
  health text not null check (
    health in ('starting', 'healthy', 'unhealthy', 'none', 'unknown')
  ),
  restart_count integer not null check (restart_count >= 0),
  oom_killed boolean not null,
  exit_code integer,
  unique (heartbeat_id, container_name)
);

create index if not exists container_samples_host_name_received_idx
  on public.container_samples (host_id, container_name, received_at desc);

alter table public.container_samples enable row level security;

revoke all on table public.container_samples from anon, authenticated;
revoke all on sequence public.container_samples_id_seq from anon, authenticated;
grant select on table public.container_samples to service_role;

drop policy if exists "deny_public_container_samples_access" on public.container_samples;
create policy "deny_public_container_samples_access"
on public.container_samples
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

drop function if exists public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision
);

create function public.insert_agent_heartbeat(
  p_server_id text,
  p_agent_version text,
  p_sent_at timestamptz,
  p_request_nonce text,
  p_body_sha256 text,
  p_cpu_count integer,
  p_memory_total_bytes bigint,
  p_memory_available_bytes bigint,
  p_disk_total_bytes bigint,
  p_disk_available_bytes bigint,
  p_load_average_1 double precision,
  p_load_average_5 double precision,
  p_load_average_15 double precision,
  p_uptime_seconds double precision,
  p_containers jsonb default '[]'::jsonb
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_host_id uuid;
  v_enabled boolean;
  v_latest_received_at timestamptz;
  v_received_at timestamptz;
  v_heartbeat_id bigint;
  v_container jsonb;
begin
  if p_containers is null
     or jsonb_typeof(p_containers) <> 'array'
     or jsonb_array_length(p_containers) > 20 then
    return 'invalid_payload';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_containers) as item(value)
    where jsonb_typeof(value) <> 'object'
       or coalesce(value->>'name', '') !~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
       or coalesce(value->>'state', '') not in (
         'created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead', 'unknown', 'not_found'
       )
       or coalesce(value->>'health', '') not in (
         'starting', 'healthy', 'unhealthy', 'none', 'unknown'
       )
       or coalesce(jsonb_typeof(value->'restartCount'), '') <> 'number'
       or (value->>'restartCount')::numeric <> trunc((value->>'restartCount')::numeric)
       or (value->>'restartCount')::numeric < 0
       or (value->>'restartCount')::numeric > 2147483647
       or coalesce(jsonb_typeof(value->'oomKilled'), '') <> 'boolean'
       or (
         value ? 'exitCode'
         and value->'exitCode' <> 'null'::jsonb
         and (
           jsonb_typeof(value->'exitCode') <> 'number'
           or (value->>'exitCode')::numeric <> trunc((value->>'exitCode')::numeric)
           or (value->>'exitCode')::numeric < -2147483648
           or (value->>'exitCode')::numeric > 2147483647
         )
       )
  ) then
    return 'invalid_payload';
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_containers)
  ) <> (
    select count(distinct value->>'name')
    from jsonb_array_elements(p_containers) as item(value)
  ) then
    return 'invalid_payload';
  end if;

  select id, enabled
  into v_host_id, v_enabled
  from public.hosts
  where server_id = p_server_id
  for update;

  if not found or not v_enabled then
    return 'unknown_agent';
  end if;

  select received_at
  into v_latest_received_at
  from public.agent_heartbeats
  where host_id = v_host_id
  order by received_at desc
  limit 1;

  if v_latest_received_at is not null
     and clock_timestamp() - v_latest_received_at < interval '8 seconds' then
    return 'rate_limited';
  end if;

  v_received_at := clock_timestamp();

  begin
    insert into public.agent_heartbeats (
      host_id,
      agent_version,
      received_at,
      sent_at,
      request_nonce,
      body_sha256,
      cpu_count,
      memory_total_bytes,
      memory_available_bytes,
      disk_total_bytes,
      disk_available_bytes,
      load_average_1,
      load_average_5,
      load_average_15,
      uptime_seconds
    ) values (
      v_host_id,
      p_agent_version,
      v_received_at,
      p_sent_at,
      p_request_nonce,
      p_body_sha256,
      p_cpu_count,
      p_memory_total_bytes,
      p_memory_available_bytes,
      p_disk_total_bytes,
      p_disk_available_bytes,
      p_load_average_1,
      p_load_average_5,
      p_load_average_15,
      p_uptime_seconds
    )
    returning id into v_heartbeat_id;
  exception
    when unique_violation then
      return 'replayed_request';
  end;

  for v_container in
    select value
    from jsonb_array_elements(p_containers) as item(value)
  loop
    insert into public.container_samples (
      heartbeat_id,
      host_id,
      received_at,
      container_name,
      state,
      health,
      restart_count,
      oom_killed,
      exit_code
    ) values (
      v_heartbeat_id,
      v_host_id,
      v_received_at,
      v_container->>'name',
      v_container->>'state',
      v_container->>'health',
      (v_container->>'restartCount')::integer,
      (v_container->>'oomKilled')::boolean,
      case
        when not (v_container ? 'exitCode') or v_container->'exitCode' = 'null'::jsonb then null
        else (v_container->>'exitCode')::integer
      end
    );
  end loop;

  return 'accepted';
end;
$$;

revoke all on function public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision,
  jsonb
) from public, anon, authenticated;

grant execute on function public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision,
  jsonb
) to service_role;

comment on table public.container_samples is '許可済みDockerコンテナの読み取り専用状態スナップショット';

comment on function public.insert_agent_heartbeat(
  text,
  text,
  timestamptz,
  text,
  text,
  integer,
  bigint,
  bigint,
  bigint,
  bigint,
  double precision,
  double precision,
  double precision,
  double precision,
  jsonb
) is 'Host単位の行ロック内でHeartbeatとDockerコンテナ状態を原子的に保存する';
