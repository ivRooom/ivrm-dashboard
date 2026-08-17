alter table public.minecraft_samples
  add column if not exists performance_source text,
  add column if not exists tps_1m double precision,
  add column if not exists tps_5m double precision,
  add column if not exists tps_15m double precision,
  add column if not exists mspt_median_1m double precision,
  add column if not exists mspt_p95_1m double precision,
  add column if not exists mspt_max_1m double precision;

alter table public.minecraft_samples
  drop constraint if exists minecraft_samples_performance_values_check;

alter table public.minecraft_samples
  add constraint minecraft_samples_performance_values_check check (
    (
      performance_source is null
      and tps_1m is null
      and tps_5m is null
      and tps_15m is null
      and mspt_median_1m is null
      and mspt_p95_1m is null
      and mspt_max_1m is null
    )
    or (
      performance_source = 'spark'
      and tps_1m between 0 and 1000
      and tps_5m between 0 and 1000
      and tps_15m between 0 and 1000
      and mspt_median_1m between 0 and 60000
      and mspt_p95_1m between 0 and 60000
      and mspt_max_1m between 0 and 60000
      and mspt_median_1m <= mspt_p95_1m
      and mspt_p95_1m <= mspt_max_1m
    )
  );

create or replace function public.insert_agent_heartbeat_v3(
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
  v_performance jsonb;
  v_tps_1m numeric;
  v_tps_5m numeric;
  v_tps_15m numeric;
  v_mspt_median_1m numeric;
  v_mspt_p95_1m numeric;
  v_mspt_max_1m numeric;
begin
  if p_minecraft is not null
     and p_minecraft ? 'performance'
     and p_minecraft->'performance' <> 'null'::jsonb then
    v_performance := p_minecraft->'performance';

    if jsonb_typeof(v_performance) <> 'object'
       or jsonb_typeof(v_performance->'source') <> 'string'
       or v_performance->>'source' <> 'spark'
       or jsonb_typeof(v_performance->'tps1m') <> 'number'
       or jsonb_typeof(v_performance->'tps5m') <> 'number'
       or jsonb_typeof(v_performance->'tps15m') <> 'number'
       or jsonb_typeof(v_performance->'msptMedian1m') <> 'number'
       or jsonb_typeof(v_performance->'msptP95_1m') <> 'number'
       or jsonb_typeof(v_performance->'msptMax1m') <> 'number' then
      return 'invalid_payload';
    end if;

    begin
      v_tps_1m := (v_performance->>'tps1m')::numeric;
      v_tps_5m := (v_performance->>'tps5m')::numeric;
      v_tps_15m := (v_performance->>'tps15m')::numeric;
      v_mspt_median_1m := (v_performance->>'msptMedian1m')::numeric;
      v_mspt_p95_1m := (v_performance->>'msptP95_1m')::numeric;
      v_mspt_max_1m := (v_performance->>'msptMax1m')::numeric;
    exception when others then
      return 'invalid_payload';
    end;

    if v_tps_1m < 0 or v_tps_1m > 1000
       or v_tps_5m < 0 or v_tps_5m > 1000
       or v_tps_15m < 0 or v_tps_15m > 1000
       or v_mspt_median_1m < 0 or v_mspt_median_1m > 60000
       or v_mspt_p95_1m < 0 or v_mspt_p95_1m > 60000
       or v_mspt_max_1m < 0 or v_mspt_max_1m > 60000
       or v_mspt_median_1m > v_mspt_p95_1m
       or v_mspt_p95_1m > v_mspt_max_1m then
      return 'invalid_payload';
    end if;
  end if;

  v_result := public.insert_agent_heartbeat_v2(
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
    p_containers,
    p_minecraft
  );

  if v_result <> 'accepted' or v_performance is null then
    return v_result;
  end if;

  update public.minecraft_samples as samples
  set
    performance_source = 'spark',
    tps_1m = v_tps_1m::double precision,
    tps_5m = v_tps_5m::double precision,
    tps_15m = v_tps_15m::double precision,
    mspt_median_1m = v_mspt_median_1m::double precision,
    mspt_p95_1m = v_mspt_p95_1m::double precision,
    mspt_max_1m = v_mspt_max_1m::double precision
  from public.agent_heartbeats as heartbeats
  join public.hosts as hosts on hosts.id = heartbeats.host_id
  where samples.heartbeat_id = heartbeats.id
    and hosts.server_id = p_server_id
    and heartbeats.request_nonce = p_request_nonce;

  if not found then
    raise exception 'accepted Minecraft heartbeat was not found';
  end if;

  return v_result;
end;
$$;

revoke all on function public.insert_agent_heartbeat_v3(
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

grant execute on function public.insert_agent_heartbeat_v3(
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

comment on column public.minecraft_samples.performance_source is
  'サーバー内部性能メトリクスの取得元。現在はsparkのみ';
comment on column public.minecraft_samples.tps_1m is
  'spark tpsが返した1分rolling TPS';
comment on column public.minecraft_samples.tps_5m is
  'spark tpsが返した5分rolling TPS';
comment on column public.minecraft_samples.tps_15m is
  'spark tpsが返した15分rolling TPS';
comment on column public.minecraft_samples.mspt_median_1m is
  'spark tpsが返した直近1分Tick duration median (ms)';
comment on column public.minecraft_samples.mspt_p95_1m is
  'spark tpsが返した直近1分Tick duration 95 percentile (ms)';
comment on column public.minecraft_samples.mspt_max_1m is
  'spark tpsが返した直近1分Tick duration max (ms)';
comment on function public.insert_agent_heartbeat_v3(
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
) is 'Heartbeat v2互換の保存に任意のSpark TPS/MSPTを追加する';
