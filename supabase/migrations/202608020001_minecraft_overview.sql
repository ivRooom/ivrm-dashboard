create table if not exists public.minecraft_samples (
  id bigint generated always as identity primary key,
  heartbeat_id bigint not null unique
    references public.agent_heartbeats(id) on delete cascade,
  host_id uuid not null references public.hosts(id) on delete cascade,
  received_at timestamptz not null,
  public_reachable boolean not null,
  public_latency_ms integer,
  public_version text,
  public_online integer,
  public_max integer,
  backend_reachable boolean not null,
  backend_latency_ms integer,
  backend_version text,
  backend_online integer,
  backend_max integer,
  proxy_port_published boolean not null,
  backend_port_published boolean not null,
  voice_chat_port_published boolean not null,
  constraint minecraft_samples_public_values_check check (
    (
      public_reachable
      and public_latency_ms is not null
      and public_version is not null
      and public_online is not null
      and public_max is not null
      and public_latency_ms between 0 and 60000
      and char_length(public_version) between 1 and 128
      and public_online between 0 and 1000000
      and public_max between 1 and 1000000
      and public_online <= public_max
    )
    or (
      not public_reachable
      and public_latency_ms is null
      and public_version is null
      and public_online is null
      and public_max is null
    )
  ),
  constraint minecraft_samples_backend_values_check check (
    (
      backend_reachable
      and backend_latency_ms is not null
      and backend_version is not null
      and backend_online is not null
      and backend_max is not null
      and backend_latency_ms between 0 and 60000
      and char_length(backend_version) between 1 and 128
      and backend_online between 0 and 1000000
      and backend_max between 1 and 1000000
      and backend_online <= backend_max
    )
    or (
      not backend_reachable
      and backend_latency_ms is null
      and backend_version is null
      and backend_online is null
      and backend_max is null
    )
  )
);

create index if not exists minecraft_samples_host_received_at_idx
  on public.minecraft_samples (host_id, received_at desc);

alter table public.minecraft_samples enable row level security;

revoke all on table public.minecraft_samples from anon, authenticated;
grant select on table public.minecraft_samples to service_role;

drop policy if exists "deny_public_minecraft_samples_access"
  on public.minecraft_samples;
create policy "deny_public_minecraft_samples_access"
on public.minecraft_samples
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

insert into public.container_expectations (
  host_id,
  container_name,
  expected_state
)
select id, 'ivrm-velocity', 'running'
from public.hosts
where server_id = 'oci-minecraft-01'
on conflict (host_id, container_name)
do update set
  expected_state = excluded.expected_state,
  updated_at = clock_timestamp();

create or replace function public.insert_agent_heartbeat_v2(
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
  p_containers jsonb default '[]'::jsonb,
  p_minecraft jsonb default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_result text;
  v_heartbeat_id bigint;
  v_host_id uuid;
  v_received_at timestamptz;
  v_endpoint jsonb;
  v_reachable boolean;
  v_latency numeric;
  v_online numeric;
  v_max numeric;
  v_version text;
begin
  if p_minecraft is not null then
    if jsonb_typeof(p_minecraft) <> 'object'
       or jsonb_typeof(p_minecraft->'publicEndpoint') <> 'object'
       or jsonb_typeof(p_minecraft->'backend') <> 'object'
       or jsonb_typeof(p_minecraft->'proxyPortPublished') <> 'boolean'
       or jsonb_typeof(p_minecraft->'backendPortPublished') <> 'boolean'
       or jsonb_typeof(p_minecraft->'voiceChatPortPublished') <> 'boolean' then
      return 'invalid_payload';
    end if;

    foreach v_endpoint in array array[
      p_minecraft->'publicEndpoint',
      p_minecraft->'backend'
    ]
    loop
      if jsonb_typeof(v_endpoint->'reachable') <> 'boolean' then
        return 'invalid_payload';
      end if;
      v_reachable := (v_endpoint->>'reachable')::boolean;

      if not v_reachable then
        if (v_endpoint ? 'latencyMs' and v_endpoint->'latencyMs' <> 'null'::jsonb)
           or (v_endpoint ? 'version' and v_endpoint->'version' <> 'null'::jsonb)
           or (v_endpoint ? 'online' and v_endpoint->'online' <> 'null'::jsonb)
           or (v_endpoint ? 'max' and v_endpoint->'max' <> 'null'::jsonb) then
          return 'invalid_payload';
        end if;
        continue;
      end if;

      if jsonb_typeof(v_endpoint->'latencyMs') <> 'number'
         or jsonb_typeof(v_endpoint->'version') <> 'string'
         or jsonb_typeof(v_endpoint->'online') <> 'number'
         or jsonb_typeof(v_endpoint->'max') <> 'number' then
        return 'invalid_payload';
      end if;

      begin
        v_latency := (v_endpoint->>'latencyMs')::numeric;
        v_online := (v_endpoint->>'online')::numeric;
        v_max := (v_endpoint->>'max')::numeric;
        v_version := btrim(v_endpoint->>'version');
      exception when others then
        return 'invalid_payload';
      end;

      if v_latency <> trunc(v_latency)
         or v_latency < 0
         or v_latency > 60000
         or v_online <> trunc(v_online)
         or v_online < 0
         or v_online > 1000000
         or v_max <> trunc(v_max)
         or v_max < 1
         or v_max > 1000000
         or v_online > v_max
         or char_length(v_version) < 1
         or char_length(v_version) > 128 then
        return 'invalid_payload';
      end if;
    end loop;
  end if;

  v_result := public.insert_agent_heartbeat(
    p_server_id,
    p_agent_version,
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
    p_uptime_seconds,
    p_containers
  );

  if v_result <> 'accepted' or p_minecraft is null then
    return v_result;
  end if;

  select heartbeats.id, heartbeats.host_id, heartbeats.received_at
  into v_heartbeat_id, v_host_id, v_received_at
  from public.agent_heartbeats as heartbeats
  join public.hosts as hosts on hosts.id = heartbeats.host_id
  where hosts.server_id = p_server_id
    and heartbeats.request_nonce = p_request_nonce
  limit 1;

  if not found then
    raise exception 'accepted heartbeat was not found';
  end if;

  insert into public.minecraft_samples (
    heartbeat_id,
    host_id,
    received_at,
    public_reachable,
    public_latency_ms,
    public_version,
    public_online,
    public_max,
    backend_reachable,
    backend_latency_ms,
    backend_version,
    backend_online,
    backend_max,
    proxy_port_published,
    backend_port_published,
    voice_chat_port_published
  ) values (
    v_heartbeat_id,
    v_host_id,
    v_received_at,
    (p_minecraft->'publicEndpoint'->>'reachable')::boolean,
    case when p_minecraft->'publicEndpoint'->'latencyMs' = 'null'::jsonb then null else (p_minecraft->'publicEndpoint'->>'latencyMs')::integer end,
    nullif(btrim(p_minecraft->'publicEndpoint'->>'version'), ''),
    case when p_minecraft->'publicEndpoint'->'online' = 'null'::jsonb then null else (p_minecraft->'publicEndpoint'->>'online')::integer end,
    case when p_minecraft->'publicEndpoint'->'max' = 'null'::jsonb then null else (p_minecraft->'publicEndpoint'->>'max')::integer end,
    (p_minecraft->'backend'->>'reachable')::boolean,
    case when p_minecraft->'backend'->'latencyMs' = 'null'::jsonb then null else (p_minecraft->'backend'->>'latencyMs')::integer end,
    nullif(btrim(p_minecraft->'backend'->>'version'), ''),
    case when p_minecraft->'backend'->'online' = 'null'::jsonb then null else (p_minecraft->'backend'->>'online')::integer end,
    case when p_minecraft->'backend'->'max' = 'null'::jsonb then null else (p_minecraft->'backend'->>'max')::integer end,
    (p_minecraft->>'proxyPortPublished')::boolean,
    (p_minecraft->>'backendPortPublished')::boolean,
    (p_minecraft->>'voiceChatPortPublished')::boolean
  );

  return v_result;
end;
$$;

revoke all on function public.insert_agent_heartbeat_v2(
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
  jsonb,
  jsonb
) from public, anon, authenticated;

grant execute on function public.insert_agent_heartbeat_v2(
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
  jsonb,
  jsonb
) to service_role;

comment on table public.minecraft_samples is
  '公開Velocity・Minecraftバックエンド・Voice Chat公開設定の読み取り専用サンプル';
comment on column public.minecraft_samples.backend_port_published is
  'mc-mainのMinecraft TCPポートがホストへ直接公開されているか';
comment on function public.insert_agent_heartbeat_v2(
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
  jsonb,
  jsonb
) is '既存Heartbeatと任意のMinecraft Probeを同一トランザクションで保存する';
