-- Phase 4 hardening: Burn rates use worst-in-bucket values, while SLO target is metadata
-- and must represent the latest policy observed in the display bucket.

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
      (array_agg(samples.target_percent order by samples.observed_at desc))[1] as latest_target_percent,
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
    bucketed.latest_target_percent,
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

revoke all on function public.list_reliability_burn_rate_history_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.list_reliability_burn_rate_history_v1(timestamptz, integer)
  to service_role;

comment on function public.list_reliability_burn_rate_history_v1(timestamptz, integer) is
  'Returns bounded Burn Rate trend buckets. Burn rates keep worst values; target_percent reflects the latest observed policy in each display bucket.';
