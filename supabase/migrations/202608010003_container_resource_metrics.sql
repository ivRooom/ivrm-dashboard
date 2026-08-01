alter table public.container_samples
  add column if not exists cpu_percent double precision,
  add column if not exists memory_usage_bytes bigint,
  add column if not exists memory_limit_bytes bigint,
  add column if not exists network_rx_bytes bigint,
  add column if not exists network_tx_bytes bigint,
  add column if not exists block_read_bytes bigint,
  add column if not exists block_write_bytes bigint,
  add column if not exists pids integer;

alter table public.container_samples
  drop constraint if exists container_samples_cpu_percent_check,
  drop constraint if exists container_samples_memory_usage_bytes_check,
  drop constraint if exists container_samples_memory_limit_bytes_check,
  drop constraint if exists container_samples_network_rx_bytes_check,
  drop constraint if exists container_samples_network_tx_bytes_check,
  drop constraint if exists container_samples_block_read_bytes_check,
  drop constraint if exists container_samples_block_write_bytes_check,
  drop constraint if exists container_samples_pids_check,
  drop constraint if exists container_samples_memory_range_check,
  drop constraint if exists container_samples_resource_completeness_check;

alter table public.container_samples
  add constraint container_samples_cpu_percent_check
    check (cpu_percent is null or (cpu_percent >= 0 and cpu_percent <= 100000)),
  add constraint container_samples_memory_usage_bytes_check
    check (memory_usage_bytes is null or memory_usage_bytes >= 0),
  add constraint container_samples_memory_limit_bytes_check
    check (memory_limit_bytes is null or memory_limit_bytes >= 0),
  add constraint container_samples_network_rx_bytes_check
    check (network_rx_bytes is null or network_rx_bytes >= 0),
  add constraint container_samples_network_tx_bytes_check
    check (network_tx_bytes is null or network_tx_bytes >= 0),
  add constraint container_samples_block_read_bytes_check
    check (block_read_bytes is null or block_read_bytes >= 0),
  add constraint container_samples_block_write_bytes_check
    check (block_write_bytes is null or block_write_bytes >= 0),
  add constraint container_samples_pids_check
    check (pids is null or pids >= 0),
  add constraint container_samples_memory_range_check
    check (
      memory_usage_bytes is null
      or memory_limit_bytes is null
      or memory_usage_bytes <= memory_limit_bytes
    ),
  add constraint container_samples_resource_completeness_check
    check (
      num_nonnulls(
        cpu_percent,
        memory_usage_bytes,
        memory_limit_bytes,
        network_rx_bytes,
        network_tx_bytes,
        block_read_bytes,
        block_write_bytes,
        pids
      ) in (0, 8)
    );

create or replace function public.insert_agent_heartbeat(
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
  v_name text;
  v_seen_names text[] := array[]::text[];
  v_restart_count numeric;
  v_exit_code numeric;
  v_metrics_count integer;
  v_cpu_percent numeric;
  v_memory_usage numeric;
  v_memory_limit numeric;
  v_network_rx numeric;
  v_network_tx numeric;
  v_block_read numeric;
  v_block_write numeric;
  v_pids numeric;
begin
  if p_containers is null
     or jsonb_typeof(p_containers) <> 'array'
     or jsonb_array_length(p_containers) > 20 then
    return 'invalid_payload';
  end if;

  for v_container in
    select value
    from jsonb_array_elements(p_containers) as item(value)
  loop
    if jsonb_typeof(v_container) <> 'object' then
      return 'invalid_payload';
    end if;

    v_name := coalesce(v_container->>'name', '');
    if v_name !~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
       or v_name = any(v_seen_names) then
      return 'invalid_payload';
    end if;
    v_seen_names := array_append(v_seen_names, v_name);

    if coalesce(v_container->>'state', '') not in (
         'created', 'running', 'paused', 'restarting', 'removing',
         'exited', 'dead', 'unknown', 'not_found'
       )
       or coalesce(v_container->>'health', '') not in (
         'starting', 'healthy', 'unhealthy', 'none', 'unknown'
       )
       or jsonb_typeof(v_container->'restartCount') <> 'number'
       or jsonb_typeof(v_container->'oomKilled') <> 'boolean' then
      return 'invalid_payload';
    end if;

    begin
      v_restart_count := (v_container->>'restartCount')::numeric;
    exception when others then
      return 'invalid_payload';
    end;
    if v_restart_count <> trunc(v_restart_count)
       or v_restart_count < 0
       or v_restart_count > 2147483647 then
      return 'invalid_payload';
    end if;

    if v_container ? 'exitCode'
       and v_container->'exitCode' <> 'null'::jsonb then
      if jsonb_typeof(v_container->'exitCode') <> 'number' then
        return 'invalid_payload';
      end if;
      begin
        v_exit_code := (v_container->>'exitCode')::numeric;
      exception when others then
        return 'invalid_payload';
      end;
      if v_exit_code <> trunc(v_exit_code)
         or v_exit_code < -2147483648
         or v_exit_code > 2147483647 then
        return 'invalid_payload';
      end if;
    end if;

    v_metrics_count := 0;
    if v_container ? 'cpuPercent' and v_container->'cpuPercent' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'memoryUsageBytes' and v_container->'memoryUsageBytes' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'memoryLimitBytes' and v_container->'memoryLimitBytes' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'networkRxBytes' and v_container->'networkRxBytes' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'networkTxBytes' and v_container->'networkTxBytes' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'blockReadBytes' and v_container->'blockReadBytes' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'blockWriteBytes' and v_container->'blockWriteBytes' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;
    if v_container ? 'pids' and v_container->'pids' <> 'null'::jsonb then
      v_metrics_count := v_metrics_count + 1;
    end if;

    if v_metrics_count not in (0, 8) then
      return 'invalid_payload';
    end if;

    if v_metrics_count = 8 then
      if jsonb_typeof(v_container->'cpuPercent') <> 'number'
         or jsonb_typeof(v_container->'memoryUsageBytes') <> 'number'
         or jsonb_typeof(v_container->'memoryLimitBytes') <> 'number'
         or jsonb_typeof(v_container->'networkRxBytes') <> 'number'
         or jsonb_typeof(v_container->'networkTxBytes') <> 'number'
         or jsonb_typeof(v_container->'blockReadBytes') <> 'number'
         or jsonb_typeof(v_container->'blockWriteBytes') <> 'number'
         or jsonb_typeof(v_container->'pids') <> 'number' then
        return 'invalid_payload';
      end if;

      begin
        v_cpu_percent := (v_container->>'cpuPercent')::numeric;
        v_memory_usage := (v_container->>'memoryUsageBytes')::numeric;
        v_memory_limit := (v_container->>'memoryLimitBytes')::numeric;
        v_network_rx := (v_container->>'networkRxBytes')::numeric;
        v_network_tx := (v_container->>'networkTxBytes')::numeric;
        v_block_read := (v_container->>'blockReadBytes')::numeric;
        v_block_write := (v_container->>'blockWriteBytes')::numeric;
        v_pids := (v_container->>'pids')::numeric;
      exception when others then
        return 'invalid_payload';
      end;

      if v_cpu_percent < 0 or v_cpu_percent > 100000
         or v_memory_usage <> trunc(v_memory_usage)
         or v_memory_limit <> trunc(v_memory_limit)
         or v_network_rx <> trunc(v_network_rx)
         or v_network_tx <> trunc(v_network_tx)
         or v_block_read <> trunc(v_block_read)
         or v_block_write <> trunc(v_block_write)
         or v_pids <> trunc(v_pids)
         or v_memory_usage < 0
         or v_memory_limit < 0
         or v_network_rx < 0
         or v_network_tx < 0
         or v_block_read < 0
         or v_block_write < 0
         or v_pids < 0
         or v_memory_usage > v_memory_limit
         or v_memory_usage > 9007199254740991
         or v_memory_limit > 9007199254740991
         or v_network_rx > 9007199254740991
         or v_network_tx > 9007199254740991
         or v_block_read > 9007199254740991
         or v_block_write > 9007199254740991
         or v_pids > 2147483647 then
        return 'invalid_payload';
      end if;
    end if;
  end loop;

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
      exit_code,
      cpu_percent,
      memory_usage_bytes,
      memory_limit_bytes,
      network_rx_bytes,
      network_tx_bytes,
      block_read_bytes,
      block_write_bytes,
      pids
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
      end,
      case when v_container->'cpuPercent' is null or v_container->'cpuPercent' = 'null'::jsonb then null else (v_container->>'cpuPercent')::double precision end,
      case when v_container->'memoryUsageBytes' is null or v_container->'memoryUsageBytes' = 'null'::jsonb then null else (v_container->>'memoryUsageBytes')::bigint end,
      case when v_container->'memoryLimitBytes' is null or v_container->'memoryLimitBytes' = 'null'::jsonb then null else (v_container->>'memoryLimitBytes')::bigint end,
      case when v_container->'networkRxBytes' is null or v_container->'networkRxBytes' = 'null'::jsonb then null else (v_container->>'networkRxBytes')::bigint end,
      case when v_container->'networkTxBytes' is null or v_container->'networkTxBytes' = 'null'::jsonb then null else (v_container->>'networkTxBytes')::bigint end,
      case when v_container->'blockReadBytes' is null or v_container->'blockReadBytes' = 'null'::jsonb then null else (v_container->>'blockReadBytes')::bigint end,
      case when v_container->'blockWriteBytes' is null or v_container->'blockWriteBytes' = 'null'::jsonb then null else (v_container->>'blockWriteBytes')::bigint end,
      case when v_container->'pids' is null or v_container->'pids' = 'null'::jsonb then null else (v_container->>'pids')::integer end
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

comment on column public.container_samples.cpu_percent is 'docker statsのCPU使用率';
comment on column public.container_samples.memory_usage_bytes is 'コンテナのメモリ使用量';
comment on column public.container_samples.memory_limit_bytes is 'コンテナのメモリ上限';
comment on column public.container_samples.network_rx_bytes is 'コンテナのNetwork RX累計';
comment on column public.container_samples.network_tx_bytes is 'コンテナのNetwork TX累計';
comment on column public.container_samples.block_read_bytes is 'コンテナのBlock Read累計';
comment on column public.container_samples.block_write_bytes is 'コンテナのBlock Write累計';
comment on column public.container_samples.pids is 'コンテナ内プロセス数';
