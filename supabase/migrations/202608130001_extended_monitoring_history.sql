create table if not exists public.host_metric_rollups_5m (
  host_id uuid not null references public.hosts(id) on delete cascade,
  bucket_at timestamptz not null,
  load_average_1_avg double precision,
  load_average_5_avg double precision,
  load_average_15_avg double precision,
  memory_percent_avg double precision,
  disk_percent_avg double precision,
  sample_count bigint not null check (sample_count > 0),
  primary key (host_id, bucket_at)
);

create table if not exists public.container_metric_rollups_5m (
  host_id uuid not null references public.hosts(id) on delete cascade,
  container_name text not null check (
    container_name ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
  ),
  bucket_at timestamptz not null,
  cpu_percent_avg double precision,
  memory_percent_avg double precision,
  pids_avg double precision,
  restart_count_latest integer not null check (restart_count_latest >= 0),
  network_rx_rate_bps double precision,
  network_tx_rate_bps double precision,
  block_read_rate_bps double precision,
  block_write_rate_bps double precision,
  sample_count bigint not null check (sample_count > 0),
  primary key (host_id, container_name, bucket_at),
  constraint container_metric_rollups_5m_rates_check check (
    (network_rx_rate_bps is null or network_rx_rate_bps >= 0)
    and (network_tx_rate_bps is null or network_tx_rate_bps >= 0)
    and (block_read_rate_bps is null or block_read_rate_bps >= 0)
    and (block_write_rate_bps is null or block_write_rate_bps >= 0)
  )
);

create index if not exists host_metric_rollups_5m_bucket_idx
  on public.host_metric_rollups_5m (bucket_at desc, host_id);

create index if not exists container_metric_rollups_5m_bucket_idx
  on public.container_metric_rollups_5m (bucket_at desc, host_id, container_name);

alter table public.host_metric_rollups_5m enable row level security;
alter table public.host_metric_rollups_5m force row level security;
alter table public.container_metric_rollups_5m enable row level security;
alter table public.container_metric_rollups_5m force row level security;

revoke all on table public.host_metric_rollups_5m
  from public, anon, authenticated, service_role;
revoke all on table public.container_metric_rollups_5m
  from public, anon, authenticated, service_role;

create or replace function public.refresh_observability_rollups(
  p_from timestamptz,
  p_to timestamptz default statement_timestamp()
)
returns table (
  host_buckets bigint,
  container_buckets bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_from timestamptz;
  v_to timestamptz;
  v_host_count bigint := 0;
  v_container_count bigint := 0;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'rollup_range_invalid' using errcode = '22023';
  end if;

  if p_to > v_now + interval '5 minutes'
     or p_to - p_from > interval '45 days' then
    raise exception 'rollup_range_out_of_bounds' using errcode = '22023';
  end if;

  v_from := to_timestamp(
    floor(extract(epoch from p_from) / 300) * 300
  );
  v_to := p_to;

  insert into public.host_metric_rollups_5m (
    host_id,
    bucket_at,
    load_average_1_avg,
    load_average_5_avg,
    load_average_15_avg,
    memory_percent_avg,
    disk_percent_avg,
    sample_count
  )
  select
    heartbeats.host_id,
    to_timestamp(
      floor(extract(epoch from heartbeats.received_at) / 300) * 300
    ) as bucket_at,
    avg(heartbeats.load_average_1)::double precision,
    avg(heartbeats.load_average_5)::double precision,
    avg(heartbeats.load_average_15)::double precision,
    avg(
      case
        when heartbeats.memory_total_bytes > 0 then
          (heartbeats.memory_total_bytes - heartbeats.memory_available_bytes)::numeric
          / heartbeats.memory_total_bytes::numeric * 100
        else null
      end
    )::double precision,
    avg(
      case
        when heartbeats.disk_total_bytes > 0 then
          (heartbeats.disk_total_bytes - heartbeats.disk_available_bytes)::numeric
          / heartbeats.disk_total_bytes::numeric * 100
        else null
      end
    )::double precision,
    count(*)
  from public.agent_heartbeats as heartbeats
  where heartbeats.received_at >= v_from
    and heartbeats.received_at < v_to
  group by
    heartbeats.host_id,
    to_timestamp(
      floor(extract(epoch from heartbeats.received_at) / 300) * 300
    )
  on conflict (host_id, bucket_at) do update set
    load_average_1_avg = excluded.load_average_1_avg,
    load_average_5_avg = excluded.load_average_5_avg,
    load_average_15_avg = excluded.load_average_15_avg,
    memory_percent_avg = excluded.memory_percent_avg,
    disk_percent_avg = excluded.disk_percent_avg,
    sample_count = excluded.sample_count;

  get diagnostics v_host_count = row_count;

  with raw as (
    select
      samples.host_id,
      samples.container_name,
      samples.received_at,
      samples.cpu_percent,
      samples.memory_usage_bytes,
      samples.memory_limit_bytes,
      samples.pids,
      samples.restart_count,
      samples.network_rx_bytes,
      samples.network_tx_bytes,
      samples.block_read_bytes,
      samples.block_write_bytes,
      lag(samples.received_at) over sample_window as previous_received_at,
      lag(samples.network_rx_bytes) over sample_window as previous_network_rx_bytes,
      lag(samples.network_tx_bytes) over sample_window as previous_network_tx_bytes,
      lag(samples.block_read_bytes) over sample_window as previous_block_read_bytes,
      lag(samples.block_write_bytes) over sample_window as previous_block_write_bytes
    from public.container_samples as samples
    where samples.received_at >= v_from - interval '2 minutes'
      and samples.received_at < v_to
    window sample_window as (
      partition by samples.host_id, samples.container_name
      order by samples.received_at
    )
  ), calculated as (
    select
      raw.*,
      extract(epoch from raw.received_at - raw.previous_received_at) as interval_seconds,
      case
        when raw.previous_received_at is not null
         and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
         and raw.network_rx_bytes is not null
         and raw.previous_network_rx_bytes is not null
         and raw.network_rx_bytes >= raw.previous_network_rx_bytes
        then (raw.network_rx_bytes - raw.previous_network_rx_bytes)::double precision
          / extract(epoch from raw.received_at - raw.previous_received_at)
        else null
      end as network_rx_rate_bps,
      case
        when raw.previous_received_at is not null
         and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
         and raw.network_tx_bytes is not null
         and raw.previous_network_tx_bytes is not null
         and raw.network_tx_bytes >= raw.previous_network_tx_bytes
        then (raw.network_tx_bytes - raw.previous_network_tx_bytes)::double precision
          / extract(epoch from raw.received_at - raw.previous_received_at)
        else null
      end as network_tx_rate_bps,
      case
        when raw.previous_received_at is not null
         and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
         and raw.block_read_bytes is not null
         and raw.previous_block_read_bytes is not null
         and raw.block_read_bytes >= raw.previous_block_read_bytes
        then (raw.block_read_bytes - raw.previous_block_read_bytes)::double precision
          / extract(epoch from raw.received_at - raw.previous_received_at)
        else null
      end as block_read_rate_bps,
      case
        when raw.previous_received_at is not null
         and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
         and raw.block_write_bytes is not null
         and raw.previous_block_write_bytes is not null
         and raw.block_write_bytes >= raw.previous_block_write_bytes
        then (raw.block_write_bytes - raw.previous_block_write_bytes)::double precision
          / extract(epoch from raw.received_at - raw.previous_received_at)
        else null
      end as block_write_rate_bps
    from raw
    where raw.received_at >= v_from
  ), bucketed as (
    select
      calculated.host_id,
      calculated.container_name,
      to_timestamp(
        floor(extract(epoch from calculated.received_at) / 300) * 300
      ) as bucket_at,
      avg(calculated.cpu_percent)::double precision as cpu_percent_avg,
      avg(
        case
          when calculated.memory_usage_bytes is not null
           and calculated.memory_limit_bytes is not null
           and calculated.memory_limit_bytes > 0
          then calculated.memory_usage_bytes::numeric
            / calculated.memory_limit_bytes::numeric * 100
          else null
        end
      )::double precision as memory_percent_avg,
      avg(calculated.pids)::double precision as pids_avg,
      (array_agg(
        calculated.restart_count
        order by calculated.received_at desc
      ))[1] as restart_count_latest,
      avg(calculated.network_rx_rate_bps)::double precision as network_rx_rate_bps,
      avg(calculated.network_tx_rate_bps)::double precision as network_tx_rate_bps,
      avg(calculated.block_read_rate_bps)::double precision as block_read_rate_bps,
      avg(calculated.block_write_rate_bps)::double precision as block_write_rate_bps,
      count(*) as sample_count
    from calculated
    group by
      calculated.host_id,
      calculated.container_name,
      to_timestamp(
        floor(extract(epoch from calculated.received_at) / 300) * 300
      )
  )
  insert into public.container_metric_rollups_5m (
    host_id,
    container_name,
    bucket_at,
    cpu_percent_avg,
    memory_percent_avg,
    pids_avg,
    restart_count_latest,
    network_rx_rate_bps,
    network_tx_rate_bps,
    block_read_rate_bps,
    block_write_rate_bps,
    sample_count
  )
  select
    bucketed.host_id,
    bucketed.container_name,
    bucketed.bucket_at,
    bucketed.cpu_percent_avg,
    bucketed.memory_percent_avg,
    bucketed.pids_avg,
    bucketed.restart_count_latest,
    bucketed.network_rx_rate_bps,
    bucketed.network_tx_rate_bps,
    bucketed.block_read_rate_bps,
    bucketed.block_write_rate_bps,
    bucketed.sample_count
  from bucketed
  on conflict (host_id, container_name, bucket_at) do update set
    cpu_percent_avg = excluded.cpu_percent_avg,
    memory_percent_avg = excluded.memory_percent_avg,
    pids_avg = excluded.pids_avg,
    restart_count_latest = excluded.restart_count_latest,
    network_rx_rate_bps = excluded.network_rx_rate_bps,
    network_tx_rate_bps = excluded.network_tx_rate_bps,
    block_read_rate_bps = excluded.block_read_rate_bps,
    block_write_rate_bps = excluded.block_write_rate_bps,
    sample_count = excluded.sample_count;

  get diagnostics v_container_count = row_count;

  return query select v_host_count, v_container_count;
end;
$$;

revoke all on function public.refresh_observability_rollups(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.refresh_observability_rollups(timestamptz, timestamptz)
  to service_role;

create or replace function public.get_host_metric_history_v2(
  p_range text default '24h'
)
returns table (
  host_id uuid,
  host_display_name text,
  data_source text,
  bucket_seconds integer,
  points jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_hours integer;
  v_bucket_seconds integer;
  v_source text;
  v_start timestamptz;
begin
  case p_range
    when '1h' then v_hours := 1; v_bucket_seconds := 60; v_source := 'raw';
    when '6h' then v_hours := 6; v_bucket_seconds := 120; v_source := 'raw';
    when '24h' then v_hours := 24; v_bucket_seconds := 300; v_source := 'raw';
    when '7d' then v_hours := 168; v_bucket_seconds := 1800; v_source := 'rollup_5m';
    when '30d' then v_hours := 720; v_bucket_seconds := 3600; v_source := 'rollup_5m';
    else raise exception 'history_range_invalid' using errcode = '22023';
  end case;

  if ceil(v_hours::numeric * 3600 / v_bucket_seconds) > 2000 then
    raise exception 'history_bucket_limit_exceeded' using errcode = '22023';
  end if;

  v_start := statement_timestamp() - make_interval(hours => v_hours);

  if v_source = 'raw' then
    return query
    with bucketed as (
      select
        heartbeats.host_id,
        to_timestamp(
          floor(extract(epoch from heartbeats.received_at) / v_bucket_seconds)
          * v_bucket_seconds
        ) as bucket_at,
        avg(heartbeats.load_average_1)::double precision as load_average_1,
        avg(heartbeats.load_average_5)::double precision as load_average_5,
        avg(heartbeats.load_average_15)::double precision as load_average_15,
        avg(
          case
            when heartbeats.memory_total_bytes > 0 then
              (heartbeats.memory_total_bytes - heartbeats.memory_available_bytes)::numeric
              / heartbeats.memory_total_bytes::numeric * 100
            else null
          end
        )::double precision as memory_percent,
        avg(
          case
            when heartbeats.disk_total_bytes > 0 then
              (heartbeats.disk_total_bytes - heartbeats.disk_available_bytes)::numeric
              / heartbeats.disk_total_bytes::numeric * 100
            else null
          end
        )::double precision as disk_percent,
        count(*) as sample_count
      from public.agent_heartbeats as heartbeats
      where heartbeats.received_at >= v_start
      group by
        heartbeats.host_id,
        to_timestamp(
          floor(extract(epoch from heartbeats.received_at) / v_bucket_seconds)
          * v_bucket_seconds
        )
    )
    select
      bucketed.host_id,
      hosts.display_name,
      v_source,
      v_bucket_seconds,
      jsonb_agg(
        jsonb_build_object(
          'timestamp', bucketed.bucket_at,
          'loadAverage1', bucketed.load_average_1,
          'loadAverage5', bucketed.load_average_5,
          'loadAverage15', bucketed.load_average_15,
          'memoryPercent', bucketed.memory_percent,
          'diskPercent', bucketed.disk_percent,
          'sampleCount', bucketed.sample_count
        ) order by bucketed.bucket_at
      )
    from bucketed
    join public.hosts as hosts on hosts.id = bucketed.host_id
    where hosts.enabled
    group by bucketed.host_id, hosts.display_name
    order by hosts.display_name;
  else
    return query
    with regrouped as (
      select
        rollups.host_id,
        to_timestamp(
          floor(extract(epoch from rollups.bucket_at) / v_bucket_seconds)
          * v_bucket_seconds
        ) as bucket_at,
        (
          sum(rollups.load_average_1_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.load_average_1_avg is not null
            ), 0)
        )::double precision as load_average_1,
        (
          sum(rollups.load_average_5_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.load_average_5_avg is not null
            ), 0)
        )::double precision as load_average_5,
        (
          sum(rollups.load_average_15_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.load_average_15_avg is not null
            ), 0)
        )::double precision as load_average_15,
        (
          sum(rollups.memory_percent_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.memory_percent_avg is not null
            ), 0)
        )::double precision as memory_percent,
        (
          sum(rollups.disk_percent_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.disk_percent_avg is not null
            ), 0)
        )::double precision as disk_percent,
        sum(rollups.sample_count)::bigint as sample_count
      from public.host_metric_rollups_5m as rollups
      where rollups.bucket_at >= v_start
      group by
        rollups.host_id,
        to_timestamp(
          floor(extract(epoch from rollups.bucket_at) / v_bucket_seconds)
          * v_bucket_seconds
        )
    )
    select
      regrouped.host_id,
      hosts.display_name,
      v_source,
      v_bucket_seconds,
      jsonb_agg(
        jsonb_build_object(
          'timestamp', regrouped.bucket_at,
          'loadAverage1', regrouped.load_average_1,
          'loadAverage5', regrouped.load_average_5,
          'loadAverage15', regrouped.load_average_15,
          'memoryPercent', regrouped.memory_percent,
          'diskPercent', regrouped.disk_percent,
          'sampleCount', regrouped.sample_count
        ) order by regrouped.bucket_at
      )
    from regrouped
    join public.hosts as hosts on hosts.id = regrouped.host_id
    where hosts.enabled
    group by regrouped.host_id, hosts.display_name
    order by hosts.display_name;
  end if;
end;
$$;

create or replace function public.get_container_metric_history_v2(
  p_range text default '24h'
)
returns table (
  host_id uuid,
  host_display_name text,
  container_name text,
  data_source text,
  bucket_seconds integer,
  points jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_hours integer;
  v_bucket_seconds integer;
  v_source text;
  v_start timestamptz;
begin
  case p_range
    when '1h' then v_hours := 1; v_bucket_seconds := 60; v_source := 'raw';
    when '6h' then v_hours := 6; v_bucket_seconds := 120; v_source := 'raw';
    when '24h' then v_hours := 24; v_bucket_seconds := 300; v_source := 'raw';
    when '7d' then v_hours := 168; v_bucket_seconds := 1800; v_source := 'rollup_5m';
    when '30d' then v_hours := 720; v_bucket_seconds := 3600; v_source := 'rollup_5m';
    else raise exception 'history_range_invalid' using errcode = '22023';
  end case;

  if ceil(v_hours::numeric * 3600 / v_bucket_seconds) > 2000 then
    raise exception 'history_bucket_limit_exceeded' using errcode = '22023';
  end if;

  v_start := statement_timestamp() - make_interval(hours => v_hours);

  if v_source = 'raw' then
    return query
    with raw as (
      select
        samples.host_id,
        samples.container_name,
        samples.received_at,
        samples.cpu_percent,
        samples.memory_usage_bytes,
        samples.memory_limit_bytes,
        samples.pids,
        samples.restart_count,
        samples.network_rx_bytes,
        samples.network_tx_bytes,
        samples.block_read_bytes,
        samples.block_write_bytes,
        lag(samples.received_at) over sample_window as previous_received_at,
        lag(samples.network_rx_bytes) over sample_window as previous_network_rx_bytes,
        lag(samples.network_tx_bytes) over sample_window as previous_network_tx_bytes,
        lag(samples.block_read_bytes) over sample_window as previous_block_read_bytes,
        lag(samples.block_write_bytes) over sample_window as previous_block_write_bytes
      from public.container_samples as samples
      where samples.received_at >= v_start - interval '2 minutes'
      window sample_window as (
        partition by samples.host_id, samples.container_name
        order by samples.received_at
      )
    ), calculated as (
      select
        raw.*,
        case
          when raw.previous_received_at is not null
           and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
           and raw.network_rx_bytes is not null
           and raw.previous_network_rx_bytes is not null
           and raw.network_rx_bytes >= raw.previous_network_rx_bytes
          then (raw.network_rx_bytes - raw.previous_network_rx_bytes)::double precision
            / extract(epoch from raw.received_at - raw.previous_received_at)
          else null
        end as network_rx_rate_bps,
        case
          when raw.previous_received_at is not null
           and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
           and raw.network_tx_bytes is not null
           and raw.previous_network_tx_bytes is not null
           and raw.network_tx_bytes >= raw.previous_network_tx_bytes
          then (raw.network_tx_bytes - raw.previous_network_tx_bytes)::double precision
            / extract(epoch from raw.received_at - raw.previous_received_at)
          else null
        end as network_tx_rate_bps,
        case
          when raw.previous_received_at is not null
           and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
           and raw.block_read_bytes is not null
           and raw.previous_block_read_bytes is not null
           and raw.block_read_bytes >= raw.previous_block_read_bytes
          then (raw.block_read_bytes - raw.previous_block_read_bytes)::double precision
            / extract(epoch from raw.received_at - raw.previous_received_at)
          else null
        end as block_read_rate_bps,
        case
          when raw.previous_received_at is not null
           and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
           and raw.block_write_bytes is not null
           and raw.previous_block_write_bytes is not null
           and raw.block_write_bytes >= raw.previous_block_write_bytes
          then (raw.block_write_bytes - raw.previous_block_write_bytes)::double precision
            / extract(epoch from raw.received_at - raw.previous_received_at)
          else null
        end as block_write_rate_bps
      from raw
      where raw.received_at >= v_start
    ), bucketed as (
      select
        calculated.host_id,
        calculated.container_name,
        to_timestamp(
          floor(extract(epoch from calculated.received_at) / v_bucket_seconds)
          * v_bucket_seconds
        ) as bucket_at,
        avg(calculated.cpu_percent)::double precision as cpu_percent,
        avg(
          case
            when calculated.memory_usage_bytes is not null
             and calculated.memory_limit_bytes is not null
             and calculated.memory_limit_bytes > 0
            then calculated.memory_usage_bytes::numeric
              / calculated.memory_limit_bytes::numeric * 100
            else null
          end
        )::double precision as memory_percent,
        avg(calculated.pids)::double precision as pids,
        (array_agg(
          calculated.restart_count
          order by calculated.received_at desc
        ))[1] as restart_count,
        avg(calculated.network_rx_rate_bps)::double precision as network_rx_rate_bps,
        avg(calculated.network_tx_rate_bps)::double precision as network_tx_rate_bps,
        avg(calculated.block_read_rate_bps)::double precision as block_read_rate_bps,
        avg(calculated.block_write_rate_bps)::double precision as block_write_rate_bps,
        count(*) as sample_count
      from calculated
      group by
        calculated.host_id,
        calculated.container_name,
        to_timestamp(
          floor(extract(epoch from calculated.received_at) / v_bucket_seconds)
          * v_bucket_seconds
        )
    )
    select
      bucketed.host_id,
      hosts.display_name,
      bucketed.container_name,
      v_source,
      v_bucket_seconds,
      jsonb_agg(
        jsonb_build_object(
          'timestamp', bucketed.bucket_at,
          'cpuPercent', bucketed.cpu_percent,
          'memoryPercent', bucketed.memory_percent,
          'pids', bucketed.pids,
          'restartCount', bucketed.restart_count,
          'networkRxRateBps', bucketed.network_rx_rate_bps,
          'networkTxRateBps', bucketed.network_tx_rate_bps,
          'blockReadRateBps', bucketed.block_read_rate_bps,
          'blockWriteRateBps', bucketed.block_write_rate_bps,
          'sampleCount', bucketed.sample_count
        ) order by bucketed.bucket_at
      )
    from bucketed
    join public.hosts as hosts on hosts.id = bucketed.host_id
    where hosts.enabled
    group by bucketed.host_id, hosts.display_name, bucketed.container_name
    order by hosts.display_name, bucketed.container_name;
  else
    return query
    with regrouped as (
      select
        rollups.host_id,
        rollups.container_name,
        to_timestamp(
          floor(extract(epoch from rollups.bucket_at) / v_bucket_seconds)
          * v_bucket_seconds
        ) as bucket_at,
        (
          sum(rollups.cpu_percent_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.cpu_percent_avg is not null
            ), 0)
        )::double precision as cpu_percent,
        (
          sum(rollups.memory_percent_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.memory_percent_avg is not null
            ), 0)
        )::double precision as memory_percent,
        (
          sum(rollups.pids_avg * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.pids_avg is not null
            ), 0)
        )::double precision as pids,
        (array_agg(
          rollups.restart_count_latest
          order by rollups.bucket_at desc
        ))[1] as restart_count,
        (
          sum(rollups.network_rx_rate_bps * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.network_rx_rate_bps is not null
            ), 0)
        )::double precision as network_rx_rate_bps,
        (
          sum(rollups.network_tx_rate_bps * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.network_tx_rate_bps is not null
            ), 0)
        )::double precision as network_tx_rate_bps,
        (
          sum(rollups.block_read_rate_bps * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.block_read_rate_bps is not null
            ), 0)
        )::double precision as block_read_rate_bps,
        (
          sum(rollups.block_write_rate_bps * rollups.sample_count)
          / nullif(sum(rollups.sample_count) filter (
              where rollups.block_write_rate_bps is not null
            ), 0)
        )::double precision as block_write_rate_bps,
        sum(rollups.sample_count)::bigint as sample_count
      from public.container_metric_rollups_5m as rollups
      where rollups.bucket_at >= v_start
      group by
        rollups.host_id,
        rollups.container_name,
        to_timestamp(
          floor(extract(epoch from rollups.bucket_at) / v_bucket_seconds)
          * v_bucket_seconds
        )
    )
    select
      regrouped.host_id,
      hosts.display_name,
      regrouped.container_name,
      v_source,
      v_bucket_seconds,
      jsonb_agg(
        jsonb_build_object(
          'timestamp', regrouped.bucket_at,
          'cpuPercent', regrouped.cpu_percent,
          'memoryPercent', regrouped.memory_percent,
          'pids', regrouped.pids,
          'restartCount', regrouped.restart_count,
          'networkRxRateBps', regrouped.network_rx_rate_bps,
          'networkTxRateBps', regrouped.network_tx_rate_bps,
          'blockReadRateBps', regrouped.block_read_rate_bps,
          'blockWriteRateBps', regrouped.block_write_rate_bps,
          'sampleCount', regrouped.sample_count
        ) order by regrouped.bucket_at
      )
    from regrouped
    join public.hosts as hosts on hosts.id = regrouped.host_id
    where hosts.enabled
    group by regrouped.host_id, hosts.display_name, regrouped.container_name
    order by hosts.display_name, regrouped.container_name;
  end if;
end;
$$;

revoke all on function public.get_host_metric_history_v2(text)
  from public, anon, authenticated;
revoke all on function public.get_container_metric_history_v2(text)
  from public, anon, authenticated;
grant execute on function public.get_host_metric_history_v2(text)
  to service_role;
grant execute on function public.get_container_metric_history_v2(text)
  to service_role;

comment on table public.host_metric_rollups_5m is
  'ホスト監視メトリクスの5分ロールアップ。生データRetentionとは独立して保持する。';
comment on table public.container_metric_rollups_5m is
  'Docker監視メトリクスの5分ロールアップ。Counterはresetを除外したrateへ変換する。';
comment on function public.refresh_observability_rollups(timestamptz, timestamptz) is
  'ホスト・Dockerの5分ロールアップを最大45日範囲で再計算する。生データは削除しない。';
comment on function public.get_host_metric_history_v2(text) is
  '許可済み5期間だけを受け付け、ホスト履歴をJSON系列で返す。7日以上は5分ロールアップを利用する。';
comment on function public.get_container_metric_history_v2(text) is
  '許可済み5期間だけを受け付け、Docker履歴をJSON系列で返す。Counter resetによる負rateを返さない。';

-- 既存データを初回Backfillする。最大45日に制限し、生データは削除しない。
do $$
declare
  v_oldest timestamptz;
  v_now timestamptz := statement_timestamp();
begin
  select least(
    coalesce((select min(received_at) from public.agent_heartbeats), v_now),
    coalesce((select min(received_at) from public.container_samples), v_now)
  ) into v_oldest;

  if v_oldest < v_now then
    perform public.refresh_observability_rollups(
      greatest(v_oldest, v_now - interval '45 days'),
      v_now
    );
  end if;
end;
$$;

-- 外部SecretやHTTP呼び出しを使わず、DB内だけで直近データを増分再集約する。
create extension if not exists pg_cron;

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'ivrm-observability-rollup-5m'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'ivrm-observability-rollup-5m',
    '*/5 * * * *',
    'select public.refresh_observability_rollups(statement_timestamp() - interval ''20 minutes'', statement_timestamp());'
  );
end;
$$;
