alter table public.minecraft_metric_rollups_5m
  add column if not exists tps_1m_avg double precision,
  add column if not exists tps_5m_avg double precision,
  add column if not exists tps_15m_avg double precision,
  add column if not exists mspt_median_1m_avg double precision,
  add column if not exists mspt_p95_1m_avg double precision,
  add column if not exists mspt_max_1m_max double precision,
  add column if not exists performance_sample_count bigint not null default 0
    check (performance_sample_count >= 0);

alter table public.minecraft_metric_rollups_5m
  drop constraint if exists minecraft_metric_rollups_5m_values_check;

alter table public.minecraft_metric_rollups_5m
  add constraint minecraft_metric_rollups_5m_values_check check (
    (public_online_avg is null or public_online_avg >= 0)
    and (backend_online_avg is null or backend_online_avg >= 0)
    and (public_latency_ms_avg is null or public_latency_ms_avg >= 0)
    and (backend_latency_ms_avg is null or backend_latency_ms_avg >= 0)
    and (tps_1m_avg is null or tps_1m_avg between 0 and 1000)
    and (tps_5m_avg is null or tps_5m_avg between 0 and 1000)
    and (tps_15m_avg is null or tps_15m_avg between 0 and 1000)
    and (mspt_median_1m_avg is null or mspt_median_1m_avg between 0 and 60000)
    and (mspt_p95_1m_avg is null or mspt_p95_1m_avg between 0 and 60000)
    and (mspt_max_1m_max is null or mspt_max_1m_max between 0 and 60000)
    and performance_sample_count <= sample_count
    and (
      performance_sample_count = 0
      or (
        tps_1m_avg is not null
        and tps_5m_avg is not null
        and tps_15m_avg is not null
        and mspt_median_1m_avg is not null
        and mspt_p95_1m_avg is not null
        and mspt_max_1m_max is not null
        and mspt_median_1m_avg <= mspt_p95_1m_avg
        and mspt_p95_1m_avg <= mspt_max_1m_max
      )
    )
  );

create or replace function public.refresh_minecraft_metric_rollups_v1(
  p_from timestamptz,
  p_to timestamptz default statement_timestamp()
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_from timestamptz;
  v_to timestamptz;
  v_bucket_count bigint := 0;
begin
  if p_from is null or p_to is null or p_from >= p_to then
    raise exception 'minecraft_rollup_range_invalid' using errcode = '22023';
  end if;

  if p_to > v_now + interval '5 minutes'
     or p_to - p_from > interval '45 days' then
    raise exception 'minecraft_rollup_range_out_of_bounds' using errcode = '22023';
  end if;

  v_from := to_timestamp(
    floor(extract(epoch from p_from) / 300) * 300
  );
  v_to := p_to;

  insert into public.minecraft_metric_rollups_5m (
    host_id,
    bucket_at,
    public_online_avg,
    backend_online_avg,
    public_latency_ms_avg,
    backend_latency_ms_avg,
    public_online_sample_count,
    backend_online_sample_count,
    public_latency_sample_count,
    backend_latency_sample_count,
    tps_1m_avg,
    tps_5m_avg,
    tps_15m_avg,
    mspt_median_1m_avg,
    mspt_p95_1m_avg,
    mspt_max_1m_max,
    performance_sample_count,
    sample_count
  )
  select
    samples.host_id,
    to_timestamp(
      floor(extract(epoch from samples.received_at) / 300) * 300
    ) as bucket_at,
    avg(samples.public_online)::double precision,
    avg(samples.backend_online)::double precision,
    avg(samples.public_latency_ms)::double precision,
    avg(samples.backend_latency_ms)::double precision,
    count(samples.public_online)::bigint,
    count(samples.backend_online)::bigint,
    count(samples.public_latency_ms)::bigint,
    count(samples.backend_latency_ms)::bigint,
    avg(samples.tps_1m)::double precision,
    avg(samples.tps_5m)::double precision,
    avg(samples.tps_15m)::double precision,
    avg(samples.mspt_median_1m)::double precision,
    avg(samples.mspt_p95_1m)::double precision,
    max(samples.mspt_max_1m)::double precision,
    count(samples.tps_1m)::bigint,
    count(*)::bigint
  from public.minecraft_samples as samples
  where samples.received_at >= v_from
    and samples.received_at < v_to
  group by
    samples.host_id,
    to_timestamp(
      floor(extract(epoch from samples.received_at) / 300) * 300
    )
  on conflict (host_id, bucket_at) do update set
    public_online_avg = excluded.public_online_avg,
    backend_online_avg = excluded.backend_online_avg,
    public_latency_ms_avg = excluded.public_latency_ms_avg,
    backend_latency_ms_avg = excluded.backend_latency_ms_avg,
    public_online_sample_count = excluded.public_online_sample_count,
    backend_online_sample_count = excluded.backend_online_sample_count,
    public_latency_sample_count = excluded.public_latency_sample_count,
    backend_latency_sample_count = excluded.backend_latency_sample_count,
    tps_1m_avg = excluded.tps_1m_avg,
    tps_5m_avg = excluded.tps_5m_avg,
    tps_15m_avg = excluded.tps_15m_avg,
    mspt_median_1m_avg = excluded.mspt_median_1m_avg,
    mspt_p95_1m_avg = excluded.mspt_p95_1m_avg,
    mspt_max_1m_max = excluded.mspt_max_1m_max,
    performance_sample_count = excluded.performance_sample_count,
    sample_count = excluded.sample_count;

  get diagnostics v_bucket_count = row_count;
  return v_bucket_count;
end;
$$;

create or replace function public.get_minecraft_metric_history_v1(
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
        samples.host_id,
        to_timestamp(
          floor(extract(epoch from samples.received_at) / v_bucket_seconds)
          * v_bucket_seconds
        ) as bucket_at,
        avg(samples.public_online)::double precision as public_online,
        avg(samples.backend_online)::double precision as backend_online,
        avg(samples.public_latency_ms)::double precision as public_latency_ms,
        avg(samples.backend_latency_ms)::double precision as backend_latency_ms,
        avg(samples.tps_1m)::double precision as tps_1m,
        avg(samples.tps_5m)::double precision as tps_5m,
        avg(samples.tps_15m)::double precision as tps_15m,
        avg(samples.mspt_median_1m)::double precision as mspt_median_1m,
        avg(samples.mspt_p95_1m)::double precision as mspt_p95_1m,
        max(samples.mspt_max_1m)::double precision as mspt_max_1m,
        count(samples.tps_1m)::bigint as performance_sample_count,
        count(*)::bigint as sample_count
      from public.minecraft_samples as samples
      where samples.received_at >= v_start
      group by
        samples.host_id,
        to_timestamp(
          floor(extract(epoch from samples.received_at) / v_bucket_seconds)
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
          'publicOnline', bucketed.public_online,
          'backendOnline', bucketed.backend_online,
          'publicLatencyMs', bucketed.public_latency_ms,
          'backendLatencyMs', bucketed.backend_latency_ms,
          'tps1m', bucketed.tps_1m,
          'tps5m', bucketed.tps_5m,
          'tps15m', bucketed.tps_15m,
          'msptMedian1m', bucketed.mspt_median_1m,
          'msptP95_1m', bucketed.mspt_p95_1m,
          'msptMax1m', bucketed.mspt_max_1m,
          'performanceSampleCount', bucketed.performance_sample_count,
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
          sum(rollups.public_online_avg * rollups.public_online_sample_count)
          / nullif(sum(rollups.public_online_sample_count), 0)
        )::double precision as public_online,
        (
          sum(rollups.backend_online_avg * rollups.backend_online_sample_count)
          / nullif(sum(rollups.backend_online_sample_count), 0)
        )::double precision as backend_online,
        (
          sum(rollups.public_latency_ms_avg * rollups.public_latency_sample_count)
          / nullif(sum(rollups.public_latency_sample_count), 0)
        )::double precision as public_latency_ms,
        (
          sum(rollups.backend_latency_ms_avg * rollups.backend_latency_sample_count)
          / nullif(sum(rollups.backend_latency_sample_count), 0)
        )::double precision as backend_latency_ms,
        (
          sum(rollups.tps_1m_avg * rollups.performance_sample_count)
          / nullif(sum(rollups.performance_sample_count), 0)
        )::double precision as tps_1m,
        (
          sum(rollups.tps_5m_avg * rollups.performance_sample_count)
          / nullif(sum(rollups.performance_sample_count), 0)
        )::double precision as tps_5m,
        (
          sum(rollups.tps_15m_avg * rollups.performance_sample_count)
          / nullif(sum(rollups.performance_sample_count), 0)
        )::double precision as tps_15m,
        (
          sum(rollups.mspt_median_1m_avg * rollups.performance_sample_count)
          / nullif(sum(rollups.performance_sample_count), 0)
        )::double precision as mspt_median_1m,
        (
          sum(rollups.mspt_p95_1m_avg * rollups.performance_sample_count)
          / nullif(sum(rollups.performance_sample_count), 0)
        )::double precision as mspt_p95_1m,
        max(rollups.mspt_max_1m_max)::double precision as mspt_max_1m,
        sum(rollups.performance_sample_count)::bigint as performance_sample_count,
        sum(rollups.sample_count)::bigint as sample_count
      from public.minecraft_metric_rollups_5m as rollups
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
          'publicOnline', regrouped.public_online,
          'backendOnline', regrouped.backend_online,
          'publicLatencyMs', regrouped.public_latency_ms,
          'backendLatencyMs', regrouped.backend_latency_ms,
          'tps1m', regrouped.tps_1m,
          'tps5m', regrouped.tps_5m,
          'tps15m', regrouped.tps_15m,
          'msptMedian1m', regrouped.mspt_median_1m,
          'msptP95_1m', regrouped.mspt_p95_1m,
          'msptMax1m', regrouped.mspt_max_1m,
          'performanceSampleCount', regrouped.performance_sample_count,
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

comment on column public.minecraft_metric_rollups_5m.performance_sample_count is
  '5分bucket内でSpark TPS/MSPTが完全に取得できたSample数';
comment on column public.minecraft_metric_rollups_5m.mspt_max_1m_max is
  '5分bucket内で観測したSpark直近1分MSPT maxの最大値';
