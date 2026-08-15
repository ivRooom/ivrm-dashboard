-- Reliability v2 Phase 4: 5-minute Burn Rate history with bounded retention.
-- Alerting remains one-minute; history is compacted to 5-minute buckets for operator trend visibility.

create table public.reliability_burn_rate_samples_5m (
  service_id text not null,
  bucket_started_at timestamptz not null,
  observed_at timestamptz not null,
  state text not null,
  target_percent numeric(7,4),
  burn_rate_1h numeric(14,4),
  burn_rate_6h numeric(14,4),
  burn_rate_24h numeric(14,4),
  exact_1h boolean not null,
  exact_6h boolean not null,
  exact_24h boolean not null,
  counted_downtime_1h integer,
  counted_downtime_6h integer,
  counted_downtime_24h integer,
  maintenance_excluded_1h integer,
  maintenance_excluded_6h integer,
  maintenance_excluded_24h integer,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (service_id, bucket_started_at),
  constraint reliability_burn_samples_service_check
    check (service_id in ('overall', 'host', 'container', 'backup')),
  constraint reliability_burn_samples_state_check
    check (state in ('unconfigured', 'healthy', 'warning', 'critical', 'coverage_unknown', 'data_unavailable')),
  constraint reliability_burn_samples_target_check
    check (target_percent is null or (target_percent > 0 and target_percent < 100)),
  constraint reliability_burn_samples_rate_1h_check
    check (burn_rate_1h is null or (burn_rate_1h >= 0 and burn_rate_1h <= 1000000)),
  constraint reliability_burn_samples_rate_6h_check
    check (burn_rate_6h is null or (burn_rate_6h >= 0 and burn_rate_6h <= 1000000)),
  constraint reliability_burn_samples_rate_24h_check
    check (burn_rate_24h is null or (burn_rate_24h >= 0 and burn_rate_24h <= 1000000)),
  constraint reliability_burn_samples_counted_1h_check
    check (counted_downtime_1h is null or counted_downtime_1h between 0 and 3600),
  constraint reliability_burn_samples_counted_6h_check
    check (counted_downtime_6h is null or counted_downtime_6h between 0 and 21600),
  constraint reliability_burn_samples_counted_24h_check
    check (counted_downtime_24h is null or counted_downtime_24h between 0 and 86400),
  constraint reliability_burn_samples_excluded_1h_check
    check (maintenance_excluded_1h is null or maintenance_excluded_1h between 0 and 3600),
  constraint reliability_burn_samples_excluded_6h_check
    check (maintenance_excluded_6h is null or maintenance_excluded_6h between 0 and 21600),
  constraint reliability_burn_samples_excluded_24h_check
    check (maintenance_excluded_24h is null or maintenance_excluded_24h between 0 and 86400),
  constraint reliability_burn_samples_bucket_check
    check (bucket_started_at = date_bin(interval '5 minutes', bucket_started_at, timestamptz '2000-01-01 00:00:00+00')),
  constraint reliability_burn_samples_observed_check
    check (observed_at >= bucket_started_at and observed_at < bucket_started_at + interval '5 minutes')
);

create index reliability_burn_rate_samples_5m_time_idx
  on public.reliability_burn_rate_samples_5m (bucket_started_at desc, service_id);

alter table public.reliability_burn_rate_samples_5m enable row level security;
alter table public.reliability_burn_rate_samples_5m force row level security;
revoke all on table public.reliability_burn_rate_samples_5m
  from public, anon, authenticated, service_role;

create or replace function public.record_reliability_burn_rate_samples_v1(
  p_observed_at timestamptz,
  p_samples jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket timestamptz;
  v_count integer;
  v_distinct_services integer;
begin
  if p_observed_at is null
     or p_observed_at > clock_timestamp() + interval '2 minutes'
     or p_observed_at < clock_timestamp() - interval '10 minutes'
     or p_samples is null
     or jsonb_typeof(p_samples) <> 'array'
     or jsonb_array_length(p_samples) <> 4 then
    raise exception 'reliability_burn_history_payload_invalid' using errcode = '22023';
  end if;

  with parsed as (
    select *
    from jsonb_to_recordset(p_samples) as item(
      service_id text,
      state text,
      target_percent numeric,
      burn_rate_1h numeric,
      burn_rate_6h numeric,
      burn_rate_24h numeric,
      exact_1h boolean,
      exact_6h boolean,
      exact_24h boolean,
      counted_downtime_1h integer,
      counted_downtime_6h integer,
      counted_downtime_24h integer,
      maintenance_excluded_1h integer,
      maintenance_excluded_6h integer,
      maintenance_excluded_24h integer
    )
  )
  select count(*), count(distinct service_id)
  into v_count, v_distinct_services
  from parsed
  where service_id in ('overall', 'host', 'container', 'backup')
    and state in ('unconfigured', 'healthy', 'warning', 'critical', 'coverage_unknown', 'data_unavailable')
    and exact_1h is not null
    and exact_6h is not null
    and exact_24h is not null
    and (target_percent is null or (target_percent > 0 and target_percent < 100))
    and (burn_rate_1h is null or (burn_rate_1h >= 0 and burn_rate_1h <= 1000000))
    and (burn_rate_6h is null or (burn_rate_6h >= 0 and burn_rate_6h <= 1000000))
    and (burn_rate_24h is null or (burn_rate_24h >= 0 and burn_rate_24h <= 1000000))
    and (counted_downtime_1h is null or counted_downtime_1h between 0 and 3600)
    and (counted_downtime_6h is null or counted_downtime_6h between 0 and 21600)
    and (counted_downtime_24h is null or counted_downtime_24h between 0 and 86400)
    and (maintenance_excluded_1h is null or maintenance_excluded_1h between 0 and 3600)
    and (maintenance_excluded_6h is null or maintenance_excluded_6h between 0 and 21600)
    and (maintenance_excluded_24h is null or maintenance_excluded_24h between 0 and 86400);

  if v_count <> 4 or v_distinct_services <> 4 then
    raise exception 'reliability_burn_history_samples_invalid' using errcode = '22023';
  end if;

  v_bucket := date_bin(interval '5 minutes', p_observed_at, timestamptz '2000-01-01 00:00:00+00');

  insert into public.reliability_burn_rate_samples_5m (
    service_id,
    bucket_started_at,
    observed_at,
    state,
    target_percent,
    burn_rate_1h,
    burn_rate_6h,
    burn_rate_24h,
    exact_1h,
    exact_6h,
    exact_24h,
    counted_downtime_1h,
    counted_downtime_6h,
    counted_downtime_24h,
    maintenance_excluded_1h,
    maintenance_excluded_6h,
    maintenance_excluded_24h
  )
  select
    item.service_id,
    v_bucket,
    p_observed_at,
    item.state,
    item.target_percent,
    item.burn_rate_1h,
    item.burn_rate_6h,
    item.burn_rate_24h,
    item.exact_1h,
    item.exact_6h,
    item.exact_24h,
    item.counted_downtime_1h,
    item.counted_downtime_6h,
    item.counted_downtime_24h,
    item.maintenance_excluded_1h,
    item.maintenance_excluded_6h,
    item.maintenance_excluded_24h
  from jsonb_to_recordset(p_samples) as item(
    service_id text,
    state text,
    target_percent numeric,
    burn_rate_1h numeric,
    burn_rate_6h numeric,
    burn_rate_24h numeric,
    exact_1h boolean,
    exact_6h boolean,
    exact_24h boolean,
    counted_downtime_1h integer,
    counted_downtime_6h integer,
    counted_downtime_24h integer,
    maintenance_excluded_1h integer,
    maintenance_excluded_6h integer,
    maintenance_excluded_24h integer
  )
  on conflict (service_id, bucket_started_at) do update
  set observed_at = excluded.observed_at,
      state = excluded.state,
      target_percent = excluded.target_percent,
      burn_rate_1h = excluded.burn_rate_1h,
      burn_rate_6h = excluded.burn_rate_6h,
      burn_rate_24h = excluded.burn_rate_24h,
      exact_1h = excluded.exact_1h,
      exact_6h = excluded.exact_6h,
      exact_24h = excluded.exact_24h,
      counted_downtime_1h = excluded.counted_downtime_1h,
      counted_downtime_6h = excluded.counted_downtime_6h,
      counted_downtime_24h = excluded.counted_downtime_24h,
      maintenance_excluded_1h = excluded.maintenance_excluded_1h,
      maintenance_excluded_6h = excluded.maintenance_excluded_6h,
      maintenance_excluded_24h = excluded.maintenance_excluded_24h,
      updated_at = clock_timestamp()
  where excluded.observed_at >= public.reliability_burn_rate_samples_5m.observed_at;

  delete from public.reliability_burn_rate_samples_5m
  where bucket_started_at < clock_timestamp() - interval '30 days';

  return 4;
end;
$$;

create or replace function public.list_reliability_burn_rate_history_v1(
  p_since timestamptz,
  p_bucket_minutes integer
)
returns table (
  service_id text,
  bucket_started_at timestamptz,
  observed_at timestamptz,
  state text,
  target_percent numeric,
  burn_rate_1h numeric,
  burn_rate_6h numeric,
  burn_rate_24h numeric,
  exact_1h boolean,
  exact_6h boolean,
  exact_24h boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
begin
  if p_since is null
     or p_since < clock_timestamp() - interval '31 days'
     or p_since > clock_timestamp() + interval '1 minute'
     or p_bucket_minutes not in (5, 30, 120) then
    raise exception 'reliability_burn_history_range_invalid' using errcode = '22023';
  end if;

  return query
  with bucketed as (
    select
      samples.service_id,
      date_bin(
        make_interval(mins => p_bucket_minutes),
        samples.bucket_started_at,
        timestamptz '2000-01-01 00:00:00+00'
      ) as display_bucket,
      max(samples.observed_at) as latest_observed_at,
      max(samples.target_percent) as max_target_percent,
      max(samples.burn_rate_1h) as max_burn_rate_1h,
      max(samples.burn_rate_6h) as max_burn_rate_6h,
      max(samples.burn_rate_24h) as max_burn_rate_24h,
      bool_and(samples.exact_1h) as all_exact_1h,
      bool_and(samples.exact_6h) as all_exact_6h,
      bool_and(samples.exact_24h) as all_exact_24h,
      max(case samples.state
        when 'critical' then 6
        when 'warning' then 5
        when 'data_unavailable' then 4
        when 'coverage_unknown' then 3
        when 'healthy' then 2
        else 1
      end) as state_rank
    from public.reliability_burn_rate_samples_5m as samples
    where samples.bucket_started_at >= p_since
    group by samples.service_id, display_bucket
  )
  select
    bucketed.service_id,
    bucketed.display_bucket,
    bucketed.latest_observed_at,
    case bucketed.state_rank
      when 6 then 'critical'
      when 5 then 'warning'
      when 4 then 'data_unavailable'
      when 3 then 'coverage_unknown'
      when 2 then 'healthy'
      else 'unconfigured'
    end,
    bucketed.max_target_percent,
    bucketed.max_burn_rate_1h,
    bucketed.max_burn_rate_6h,
    bucketed.max_burn_rate_24h,
    bucketed.all_exact_1h,
    bucketed.all_exact_6h,
    bucketed.all_exact_24h
  from bucketed
  order by bucketed.display_bucket asc, bucketed.service_id asc;
end;
$$;

revoke all on function public.record_reliability_burn_rate_samples_v1(timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_reliability_burn_rate_samples_v1(timestamptz, jsonb)
  to service_role;

revoke all on function public.list_reliability_burn_rate_history_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.list_reliability_burn_rate_history_v1(timestamptz, integer)
  to service_role;

comment on table public.reliability_burn_rate_samples_5m is
  'Five-minute compacted Reliability SLO Burn Rate samples. Retained for 30 days and never used as the source of truth for alert decisions.';
comment on function public.record_reliability_burn_rate_samples_v1(timestamptz, jsonb) is
  'Records the latest four service Burn Rate snapshots into a five-minute bucket and prunes data older than 30 days.';
comment on function public.list_reliability_burn_rate_history_v1(timestamptz, integer) is
  'Returns bounded Burn Rate trend buckets. 24h uses 5m, 7d uses 30m, and 30d uses 120m display buckets.';
