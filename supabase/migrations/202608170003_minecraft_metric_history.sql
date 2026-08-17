create table if not exists public.minecraft_metric_rollups_5m (
  host_id uuid not null references public.hosts(id) on delete cascade,
  bucket_at timestamptz not null,
  public_online_avg double precision,
  backend_online_avg double precision,
  public_latency_ms_avg double precision,
  backend_latency_ms_avg double precision,
  public_online_sample_count bigint not null default 0
    check (public_online_sample_count >= 0),
  backend_online_sample_count bigint not null default 0
    check (backend_online_sample_count >= 0),
  public_latency_sample_count bigint not null default 0
    check (public_latency_sample_count >= 0),
  backend_latency_sample_count bigint not null default 0
    check (backend_latency_sample_count >= 0),
  sample_count bigint not null check (sample_count > 0),
  primary key (host_id, bucket_at),
  constraint minecraft_metric_rollups_5m_values_check check (
    (public_online_avg is null or public_online_avg >= 0)
    and (backend_online_avg is null or backend_online_avg >= 0)
    and (public_latency_ms_avg is null or public_latency_ms_avg >= 0)
    and (backend_latency_ms_avg is null or backend_latency_ms_avg >= 0)
  )
);

create index if not exists minecraft_metric_rollups_5m_bucket_idx
  on public.minecraft_metric_rollups_5m (bucket_at desc, host_id);

alter table public.minecraft_metric_rollups_5m enable row level security;
alter table public.minecraft_metric_rollups_5m force row level security;
revoke all on table public.minecraft_metric_rollups_5m
  from public, anon, authenticated, service_role;

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
    sample_count = excluded.sample_count;

  get diagnostics v_bucket_count = row_count;
  return v_bucket_count;
end;
$$;

-- 既存5分Cronの呼び出し先を変えずにMinecraft Rollupも更新する。
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
  perform public.refresh_minecraft_metric_rollups_v1(p_from, p_to);

  return query select v_host_buckets, v_container_buckets;
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

alter table public.observability_retention_state
  add column if not exists last_deleted_minecraft_rollups bigint not null default 0
    check (last_deleted_minecraft_rollups >= 0);

create or replace function public.get_observability_retention_state_v2()
returns table (
  enabled boolean,
  raw_retention_days integer,
  rollup_retention_days integer,
  batch_size integer,
  last_run_at timestamptz,
  last_raw_cutoff timestamptz,
  last_rollup_cutoff timestamptz,
  last_deleted_container_samples bigint,
  last_deleted_minecraft_samples bigint,
  last_deleted_heartbeats bigint,
  last_deleted_host_rollups bigint,
  last_deleted_container_rollups bigint,
  last_deleted_minecraft_rollups bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    state.enabled,
    state.raw_retention_days,
    state.rollup_retention_days,
    state.batch_size,
    state.last_run_at,
    state.last_raw_cutoff,
    state.last_rollup_cutoff,
    state.last_deleted_container_samples,
    state.last_deleted_minecraft_samples,
    state.last_deleted_heartbeats,
    state.last_deleted_host_rollups,
    state.last_deleted_container_rollups,
    state.last_deleted_minecraft_rollups
  from public.observability_retention_state as state
  where state.singleton_id = 1;
$$;

-- 既存Retention Cronの関数名・戻り値を維持しつつMinecraft RawをRollup確認後だけ削除する。
create or replace function public.run_observability_retention_v1()
returns table (
  run_status text,
  raw_cutoff timestamptz,
  rollup_cutoff timestamptz,
  deleted_container_samples bigint,
  deleted_minecraft_samples bigint,
  deleted_heartbeats bigint,
  deleted_host_rollups bigint,
  deleted_container_rollups bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_enabled boolean;
  v_raw_days integer;
  v_rollup_days integer;
  v_batch_size integer;
  v_raw_cutoff timestamptz;
  v_rollup_cutoff timestamptz;
  v_deleted_container bigint := 0;
  v_deleted_minecraft bigint := 0;
  v_deleted_heartbeats bigint := 0;
  v_deleted_host_rollups bigint := 0;
  v_deleted_container_rollups bigint := 0;
  v_deleted_minecraft_rollups bigint := 0;
begin
  select
    state.enabled,
    state.raw_retention_days,
    state.rollup_retention_days,
    state.batch_size
  into
    v_enabled,
    v_raw_days,
    v_rollup_days,
    v_batch_size
  from public.observability_retention_state as state
  where state.singleton_id = 1;

  if not found then
    raise exception 'observability_retention_state_missing';
  end if;

  v_raw_cutoff := statement_timestamp() - make_interval(days => v_raw_days);
  v_rollup_cutoff := statement_timestamp() - make_interval(days => v_rollup_days);

  if not v_enabled then
    return query select
      'disabled'::text,
      v_raw_cutoff,
      v_rollup_cutoff,
      0::bigint,
      0::bigint,
      0::bigint,
      0::bigint,
      0::bigint;
    return;
  end if;

  if not pg_try_advisory_xact_lock(824571903::bigint) then
    return query select
      'already_running'::text,
      v_raw_cutoff,
      v_rollup_cutoff,
      0::bigint,
      0::bigint,
      0::bigint,
      0::bigint,
      0::bigint;
    return;
  end if;

  with candidates as (
    select samples.id
    from public.container_samples as samples
    where samples.received_at < v_raw_cutoff
      and exists (
        select 1
        from public.container_metric_rollups_5m as rollups
        where rollups.host_id = samples.host_id
          and rollups.container_name = samples.container_name
          and rollups.bucket_at = to_timestamp(
            floor(extract(epoch from samples.received_at) / 300) * 300
          )
      )
    order by samples.received_at, samples.id
    limit v_batch_size
  ), deleted as (
    delete from public.container_samples as samples
    using candidates
    where samples.id = candidates.id
    returning samples.id
  )
  select count(*) into v_deleted_container from deleted;

  with candidates as (
    select samples.id
    from public.minecraft_samples as samples
    where samples.received_at < v_raw_cutoff
      and exists (
        select 1
        from public.minecraft_metric_rollups_5m as rollups
        where rollups.host_id = samples.host_id
          and rollups.bucket_at = to_timestamp(
            floor(extract(epoch from samples.received_at) / 300) * 300
          )
      )
    order by samples.received_at, samples.id
    limit v_batch_size
  ), deleted as (
    delete from public.minecraft_samples as samples
    using candidates
    where samples.id = candidates.id
    returning samples.id
  )
  select count(*) into v_deleted_minecraft from deleted;

  with candidates as (
    select heartbeats.id
    from public.agent_heartbeats as heartbeats
    where heartbeats.received_at < v_raw_cutoff
      and not exists (
        select 1 from public.container_samples as samples
        where samples.heartbeat_id = heartbeats.id
      )
      and not exists (
        select 1 from public.minecraft_samples as samples
        where samples.heartbeat_id = heartbeats.id
      )
      and exists (
        select 1
        from public.host_metric_rollups_5m as rollups
        where rollups.host_id = heartbeats.host_id
          and rollups.bucket_at = to_timestamp(
            floor(extract(epoch from heartbeats.received_at) / 300) * 300
          )
      )
    order by heartbeats.received_at, heartbeats.id
    limit v_batch_size
  ), deleted as (
    delete from public.agent_heartbeats as heartbeats
    using candidates
    where heartbeats.id = candidates.id
    returning heartbeats.id
  )
  select count(*) into v_deleted_heartbeats from deleted;

  with candidates as (
    select rollups.host_id, rollups.bucket_at
    from public.host_metric_rollups_5m as rollups
    where rollups.bucket_at < v_rollup_cutoff
    order by rollups.bucket_at, rollups.host_id
    limit v_batch_size
  ), deleted as (
    delete from public.host_metric_rollups_5m as rollups
    using candidates
    where rollups.host_id = candidates.host_id
      and rollups.bucket_at = candidates.bucket_at
    returning rollups.host_id
  )
  select count(*) into v_deleted_host_rollups from deleted;

  with candidates as (
    select rollups.host_id, rollups.container_name, rollups.bucket_at
    from public.container_metric_rollups_5m as rollups
    where rollups.bucket_at < v_rollup_cutoff
    order by rollups.bucket_at, rollups.host_id, rollups.container_name
    limit v_batch_size
  ), deleted as (
    delete from public.container_metric_rollups_5m as rollups
    using candidates
    where rollups.host_id = candidates.host_id
      and rollups.container_name = candidates.container_name
      and rollups.bucket_at = candidates.bucket_at
    returning rollups.host_id
  )
  select count(*) into v_deleted_container_rollups from deleted;

  with candidates as (
    select rollups.host_id, rollups.bucket_at
    from public.minecraft_metric_rollups_5m as rollups
    where rollups.bucket_at < v_rollup_cutoff
    order by rollups.bucket_at, rollups.host_id
    limit v_batch_size
  ), deleted as (
    delete from public.minecraft_metric_rollups_5m as rollups
    using candidates
    where rollups.host_id = candidates.host_id
      and rollups.bucket_at = candidates.bucket_at
    returning rollups.host_id
  )
  select count(*) into v_deleted_minecraft_rollups from deleted;

  update public.observability_retention_state as state
  set last_run_at = clock_timestamp(),
      last_raw_cutoff = v_raw_cutoff,
      last_rollup_cutoff = v_rollup_cutoff,
      last_deleted_container_samples = v_deleted_container,
      last_deleted_minecraft_samples = v_deleted_minecraft,
      last_deleted_heartbeats = v_deleted_heartbeats,
      last_deleted_host_rollups = v_deleted_host_rollups,
      last_deleted_container_rollups = v_deleted_container_rollups,
      last_deleted_minecraft_rollups = v_deleted_minecraft_rollups,
      updated_at = clock_timestamp()
  where state.singleton_id = 1;

  return query select
    'completed'::text,
    v_raw_cutoff,
    v_rollup_cutoff,
    v_deleted_container,
    v_deleted_minecraft,
    v_deleted_heartbeats,
    v_deleted_host_rollups,
    v_deleted_container_rollups;
end;
$$;

revoke all on function public.refresh_minecraft_metric_rollups_v1(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.refresh_observability_rollups_v2(timestamptz, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.get_minecraft_metric_history_v1(text)
  from public, anon, authenticated;
grant execute on function public.get_minecraft_metric_history_v1(text)
  to service_role;
revoke all on function public.get_observability_retention_state_v2()
  from public, anon, authenticated;
grant execute on function public.get_observability_retention_state_v2()
  to service_role;
revoke all on function public.run_observability_retention_v1()
  from public, anon, authenticated, service_role;

-- 既存Rawのうち最大45日分を先にBackfillする。現在のRaw保持上限より広くても安全に再実行できる。
do $$
declare
  v_from timestamptz;
begin
  select min(samples.received_at)
    into v_from
    from public.minecraft_samples as samples;

  if v_from is not null then
    v_from := greatest(v_from, statement_timestamp() - interval '45 days');
    perform public.refresh_minecraft_metric_rollups_v1(v_from, statement_timestamp());
  end if;
end;
$$;

comment on table public.minecraft_metric_rollups_5m is
  'Minecraft公開/BackendのOnline人数とStatus Probe Latencyを5分集約で保持する長期履歴';
comment on function public.refresh_minecraft_metric_rollups_v1(timestamptz, timestamptz) is
  'Minecraft Raw Sampleを5分Rollupへ冪等Upsertする内部関数。';
comment on function public.get_minecraft_metric_history_v1(text) is
  'Console Server向けMinecraft Online人数/Probe Latency履歴。1h/6h/24hはRaw、7d/30dは5分Rollupを利用する。';
comment on function public.get_observability_retention_state_v2() is
  'Minecraft Rollup削除件数を含むRetention状態をServer側UIへ返す。';
comment on function public.run_observability_retention_v1() is
  'Rollup確認済みRawを上限制御付きで削除し、Host/Container/Minecraft Rollupを長期保持期限で削除する内部Retention Job。';
