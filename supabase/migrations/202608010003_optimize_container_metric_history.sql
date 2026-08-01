create index if not exists container_samples_received_at_idx
  on public.container_samples (received_at desc);

create or replace function public.get_container_metric_history(
  p_hours integer default 24,
  p_bucket_seconds integer default 300
)
returns table (
  host_id uuid,
  container_name text,
  bucket_at timestamptz,
  cpu_percent double precision,
  memory_percent double precision,
  sample_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_bucket_count numeric;
begin
  if p_hours < 1 or p_hours > 720 then
    raise exception 'p_hours must be between 1 and 720';
  end if;

  if p_bucket_seconds < 60 or p_bucket_seconds > 3600 then
    raise exception 'p_bucket_seconds must be between 60 and 3600';
  end if;

  v_bucket_count := ceil(p_hours::numeric * 3600 / p_bucket_seconds);
  if v_bucket_count > 2000 then
    raise exception 'requested history exceeds 2000 buckets';
  end if;

  return query
  select
    samples.host_id,
    samples.container_name,
    to_timestamp(
      floor(extract(epoch from samples.received_at) / p_bucket_seconds)
      * p_bucket_seconds
    ) as bucket_at,
    avg(samples.cpu_percent)::double precision as cpu_percent,
    avg(
      case
        when samples.memory_usage_bytes is not null
         and samples.memory_limit_bytes is not null
         and samples.memory_limit_bytes > 0
        then samples.memory_usage_bytes::numeric
          / samples.memory_limit_bytes::numeric
          * 100
        else null
      end
    )::double precision as memory_percent,
    count(*) as sample_count
  from public.container_samples as samples
  where samples.received_at >= clock_timestamp() - make_interval(hours => p_hours)
    and (
      samples.cpu_percent is not null
      or (
        samples.memory_usage_bytes is not null
        and samples.memory_limit_bytes is not null
        and samples.memory_limit_bytes > 0
      )
    )
  group by
    samples.host_id,
    samples.container_name,
    to_timestamp(
      floor(extract(epoch from samples.received_at) / p_bucket_seconds)
      * p_bucket_seconds
    )
  order by samples.container_name, bucket_at;
end;
$$;

revoke all on function public.get_container_metric_history(integer, integer)
from public, anon, authenticated;

grant execute on function public.get_container_metric_history(integer, integer)
to service_role;

comment on function public.get_container_metric_history(integer, integer)
is 'DockerコンテナのCPU・メモリ使用率を指定期間・指定粒度・最大2000バケットで安全に集約する';
