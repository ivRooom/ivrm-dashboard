alter table public.host_metric_rollups_5m
  add column if not exists memory_sample_count bigint not null default 0 check (memory_sample_count >= 0),
  add column if not exists disk_sample_count bigint not null default 0 check (disk_sample_count >= 0);

alter table public.container_metric_rollups_5m
  add column if not exists cpu_sample_count bigint not null default 0 check (cpu_sample_count >= 0),
  add column if not exists memory_sample_count bigint not null default 0 check (memory_sample_count >= 0),
  add column if not exists pids_sample_count bigint not null default 0 check (pids_sample_count >= 0),
  add column if not exists network_rx_sample_count bigint not null default 0 check (network_rx_sample_count >= 0),
  add column if not exists network_tx_sample_count bigint not null default 0 check (network_tx_sample_count >= 0),
  add column if not exists block_read_sample_count bigint not null default 0 check (block_read_sample_count >= 0),
  add column if not exists block_write_sample_count bigint not null default 0 check (block_write_sample_count >= 0);

create or replace function public.refresh_observability_rollup_counts(
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

  with counts as (
    select
      heartbeats.host_id,
      to_timestamp(
        floor(extract(epoch from heartbeats.received_at) / 300) * 300
      ) as bucket_at,
      count(*) filter (
        where heartbeats.memory_total_bytes > 0
      )::bigint as memory_sample_count,
      count(*) filter (
        where heartbeats.disk_total_bytes > 0
      )::bigint as disk_sample_count
    from public.agent_heartbeats as heartbeats
    where heartbeats.received_at >= v_from
      and heartbeats.received_at < v_to
    group by
      heartbeats.host_id,
      to_timestamp(
        floor(extract(epoch from heartbeats.received_at) / 300) * 300
      )
  )
  update public.host_metric_rollups_5m as rollups
    set memory_sample_count = counts.memory_sample_count,
        disk_sample_count = counts.disk_sample_count
    from counts
    where rollups.host_id = counts.host_id
      and rollups.bucket_at = counts.bucket_at;

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
  ), counted as (
    select
      raw.host_id,
      raw.container_name,
      to_timestamp(
        floor(extract(epoch from raw.received_at) / 300) * 300
      ) as bucket_at,
      count(raw.cpu_percent)::bigint as cpu_sample_count,
      count(*) filter (
        where raw.memory_usage_bytes is not null
          and raw.memory_limit_bytes is not null
          and raw.memory_limit_bytes > 0
      )::bigint as memory_sample_count,
      count(raw.pids)::bigint as pids_sample_count,
      count(*) filter (
        where raw.previous_received_at is not null
          and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
          and raw.network_rx_bytes is not null
          and raw.previous_network_rx_bytes is not null
          and raw.network_rx_bytes >= raw.previous_network_rx_bytes
      )::bigint as network_rx_sample_count,
      count(*) filter (
        where raw.previous_received_at is not null
          and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
          and raw.network_tx_bytes is not null
          and raw.previous_network_tx_bytes is not null
          and raw.network_tx_bytes >= raw.previous_network_tx_bytes
      )::bigint as network_tx_sample_count,
      count(*) filter (
        where raw.previous_received_at is not null
          and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
          and raw.block_read_bytes is not null
          and raw.previous_block_read_bytes is not null
          and raw.block_read_bytes >= raw.previous_block_read_bytes
      )::bigint as block_read_sample_count,
      count(*) filter (
        where raw.previous_received_at is not null
          and extract(epoch from raw.received_at - raw.previous_received_at) between 1 and 120
          and raw.block_write_bytes is not null
          and raw.previous_block_write_bytes is not null
          and raw.block_write_bytes >= raw.previous_block_write_bytes
      )::bigint as block_write_sample_count
    from raw
    where raw.received_at >= v_from
    group by
      raw.host_id,
      raw.container_name,
      to_timestamp(
        floor(extract(epoch from raw.received_at) / 300) * 300
      )
  )
  update public.container_metric_rollups_5m as rollups
    set cpu_sample_count = counted.cpu_sample_count,
        memory_sample_count = counted.memory_sample_count,
        pids_sample_count = counted.pids_sample_count,
        network_rx_sample_count = counted.network_rx_sample_count,
        network_tx_sample_count = counted.network_tx_sample_count,
        block_read_sample_count = counted.block_read_sample_count,
        block_write_sample_count = counted.block_write_sample_count
    from counted
    where rollups.host_id = counted.host_id
      and rollups.container_name = counted.container_name
      and rollups.bucket_at = counted.bucket_at;

  get diagnostics v_container_count = row_count;
  return query select v_host_count, v_container_count;
end;
$$;

create or replace function public.refresh_observability_rollups_v2(
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
  v_host_buckets bigint;
  v_container_buckets bigint;
begin
  select refreshed.host_buckets, refreshed.container_buckets
    into v_host_buckets, v_container_buckets
    from public.refresh_observability_rollups(p_from, p_to) as refreshed;

  perform public.refresh_observability_rollup_counts(p_from, p_to);

  return query select v_host_buckets, v_container_buckets;
end;
$$;

create or replace function public.get_host_metric_history_v3(
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
  v_start timestamptz;
begin
  if p_range in ('1h', '6h', '24h') then
    return query
    select * from public.get_host_metric_history_v2(p_range);
    return;
  end if;

  case p_range
    when '7d' then v_hours := 168; v_bucket_seconds := 1800;
    when '30d' then v_hours := 720; v_bucket_seconds := 3600;
    else raise exception 'history_range_invalid' using errcode = '22023';
  end case;

  v_start := statement_timestamp() - make_interval(hours => v_hours);

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
        / nullif(sum(rollups.sample_count), 0)
      )::double precision as load_average_1,
      (
        sum(rollups.load_average_5_avg * rollups.sample_count)
        / nullif(sum(rollups.sample_count), 0)
      )::double precision as load_average_5,
      (
        sum(rollups.load_average_15_avg * rollups.sample_count)
        / nullif(sum(rollups.sample_count), 0)
      )::double precision as load_average_15,
      (
        sum(rollups.memory_percent_avg * rollups.memory_sample_count)
        / nullif(sum(rollups.memory_sample_count), 0)
      )::double precision as memory_percent,
      (
        sum(rollups.disk_percent_avg * rollups.disk_sample_count)
        / nullif(sum(rollups.disk_sample_count), 0)
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
    'rollup_5m'::text,
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
end;
$$;

create or replace function public.get_container_metric_history_v3(
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
  v_start timestamptz;
begin
  if p_range in ('1h', '6h', '24h') then
    return query
    select * from public.get_container_metric_history_v2(p_range);
    return;
  end if;

  case p_range
    when '7d' then v_hours := 168; v_bucket_seconds := 1800;
    when '30d' then v_hours := 720; v_bucket_seconds := 3600;
    else raise exception 'history_range_invalid' using errcode = '22023';
  end case;

  v_start := statement_timestamp() - make_interval(hours => v_hours);

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
        sum(rollups.cpu_percent_avg * rollups.cpu_sample_count)
        / nullif(sum(rollups.cpu_sample_count), 0)
      )::double precision as cpu_percent,
      (
        sum(rollups.memory_percent_avg * rollups.memory_sample_count)
        / nullif(sum(rollups.memory_sample_count), 0)
      )::double precision as memory_percent,
      (
        sum(rollups.pids_avg * rollups.pids_sample_count)
        / nullif(sum(rollups.pids_sample_count), 0)
      )::double precision as pids,
      (array_agg(
        rollups.restart_count_latest
        order by rollups.bucket_at desc
      ))[1] as restart_count,
      (
        sum(rollups.network_rx_rate_bps * rollups.network_rx_sample_count)
        / nullif(sum(rollups.network_rx_sample_count), 0)
      )::double precision as network_rx_rate_bps,
      (
        sum(rollups.network_tx_rate_bps * rollups.network_tx_sample_count)
        / nullif(sum(rollups.network_tx_sample_count), 0)
      )::double precision as network_tx_rate_bps,
      (
        sum(rollups.block_read_rate_bps * rollups.block_read_sample_count)
        / nullif(sum(rollups.block_read_sample_count), 0)
      )::double precision as block_read_rate_bps,
      (
        sum(rollups.block_write_rate_bps * rollups.block_write_sample_count)
        / nullif(sum(rollups.block_write_sample_count), 0)
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
    'rollup_5m'::text,
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
end;
$$;

revoke all on function public.refresh_observability_rollup_counts(timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.refresh_observability_rollups_v2(timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.get_host_metric_history_v3(text)
  from public, anon, authenticated;
revoke all on function public.get_container_metric_history_v3(text)
  from public, anon, authenticated;

revoke execute on function public.refresh_observability_rollups(timestamptz, timestamptz)
  from service_role;
revoke execute on function public.get_host_metric_history_v2(text)
  from service_role;
revoke execute on function public.get_container_metric_history_v2(text)
  from service_role;

grant execute on function public.refresh_observability_rollups_v2(timestamptz, timestamptz)
  to service_role;
grant execute on function public.get_host_metric_history_v3(text)
  to service_role;
grant execute on function public.get_container_metric_history_v3(text)
  to service_role;

comment on function public.refresh_observability_rollup_counts(timestamptz, timestamptz) is
  '5分ロールアップ内で各nullableメトリクスの有効Sample件数を再計算する。';
comment on function public.refresh_observability_rollups_v2(timestamptz, timestamptz) is
  '平均値と有効Sample件数を同じ範囲で更新するロールアップ更新入口。';
comment on function public.get_host_metric_history_v3(text) is
  '長期ホスト履歴をメトリクスごとの有効Sample件数で重み付けして返す。';
comment on function public.get_container_metric_history_v3(text) is
  '長期Docker履歴をメトリクスごとの有効Sample件数で重み付けして返す。';

-- 既存ロールアップの有効Sample件数をBackfillする。
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
    perform public.refresh_observability_rollups_v2(
      greatest(v_oldest, v_now - interval '45 days'),
      v_now
    );
  end if;
end;
$$;

-- 今後は平均値と有効Sample件数を同時に更新する。
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
    'select public.refresh_observability_rollups_v2(statement_timestamp() - interval ''20 minutes'', statement_timestamp());'
  );
end;
$$;
