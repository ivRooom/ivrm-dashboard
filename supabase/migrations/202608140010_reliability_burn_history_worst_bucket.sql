-- Phase 4 hardening: preserve short Burn spikes inside each five-minute storage bucket.
-- Policy target remains latest-observed metadata; Burn/state/coverage remain conservative.

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
      state = case greatest(
        case public.reliability_burn_rate_samples_5m.state
          when 'critical' then 6 when 'warning' then 5 when 'data_unavailable' then 4
          when 'coverage_unknown' then 3 when 'healthy' then 2 else 1 end,
        case excluded.state
          when 'critical' then 6 when 'warning' then 5 when 'data_unavailable' then 4
          when 'coverage_unknown' then 3 when 'healthy' then 2 else 1 end
      )
        when 6 then 'critical'
        when 5 then 'warning'
        when 4 then 'data_unavailable'
        when 3 then 'coverage_unknown'
        when 2 then 'healthy'
        else 'unconfigured'
      end,
      target_percent = excluded.target_percent,
      burn_rate_1h = greatest(public.reliability_burn_rate_samples_5m.burn_rate_1h, excluded.burn_rate_1h),
      burn_rate_6h = greatest(public.reliability_burn_rate_samples_5m.burn_rate_6h, excluded.burn_rate_6h),
      burn_rate_24h = greatest(public.reliability_burn_rate_samples_5m.burn_rate_24h, excluded.burn_rate_24h),
      exact_1h = public.reliability_burn_rate_samples_5m.exact_1h and excluded.exact_1h,
      exact_6h = public.reliability_burn_rate_samples_5m.exact_6h and excluded.exact_6h,
      exact_24h = public.reliability_burn_rate_samples_5m.exact_24h and excluded.exact_24h,
      counted_downtime_1h = greatest(public.reliability_burn_rate_samples_5m.counted_downtime_1h, excluded.counted_downtime_1h),
      counted_downtime_6h = greatest(public.reliability_burn_rate_samples_5m.counted_downtime_6h, excluded.counted_downtime_6h),
      counted_downtime_24h = greatest(public.reliability_burn_rate_samples_5m.counted_downtime_24h, excluded.counted_downtime_24h),
      maintenance_excluded_1h = greatest(public.reliability_burn_rate_samples_5m.maintenance_excluded_1h, excluded.maintenance_excluded_1h),
      maintenance_excluded_6h = greatest(public.reliability_burn_rate_samples_5m.maintenance_excluded_6h, excluded.maintenance_excluded_6h),
      maintenance_excluded_24h = greatest(public.reliability_burn_rate_samples_5m.maintenance_excluded_24h, excluded.maintenance_excluded_24h),
      updated_at = clock_timestamp()
  where excluded.observed_at >= public.reliability_burn_rate_samples_5m.observed_at;

  delete from public.reliability_burn_rate_samples_5m
  where bucket_started_at < clock_timestamp() - interval '30 days';

  return 4;
end;
$$;

revoke all on function public.record_reliability_burn_rate_samples_v1(timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_reliability_burn_rate_samples_v1(timestamptz, jsonb)
  to service_role;

comment on function public.record_reliability_burn_rate_samples_v1(timestamptz, jsonb) is
  'Compacts one-minute Burn snapshots into five-minute buckets. Burn/state preserve worst observed values, coverage uses logical AND, and target_percent tracks the latest observation.';
