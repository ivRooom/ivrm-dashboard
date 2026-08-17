create index if not exists agent_heartbeats_received_at_idx
  on public.agent_heartbeats (received_at desc);

create index if not exists minecraft_samples_received_at_idx
  on public.minecraft_samples (received_at desc);

create table if not exists public.observability_retention_state (
  singleton_id smallint primary key default 1 check (singleton_id = 1),
  enabled boolean not null default false,
  raw_retention_days integer not null default 7
    check (raw_retention_days between 2 and 45),
  rollup_retention_days integer not null default 90
    check (rollup_retention_days between 31 and 730),
  batch_size integer not null default 50000
    check (batch_size between 1000 and 100000),
  last_run_at timestamptz,
  last_raw_cutoff timestamptz,
  last_rollup_cutoff timestamptz,
  last_deleted_container_samples bigint not null default 0
    check (last_deleted_container_samples >= 0),
  last_deleted_minecraft_samples bigint not null default 0
    check (last_deleted_minecraft_samples >= 0),
  last_deleted_heartbeats bigint not null default 0
    check (last_deleted_heartbeats >= 0),
  last_deleted_host_rollups bigint not null default 0
    check (last_deleted_host_rollups >= 0),
  last_deleted_container_rollups bigint not null default 0
    check (last_deleted_container_rollups >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  constraint observability_retention_horizon_check check (
    rollup_retention_days >= greatest(raw_retention_days, 31)
  )
);

insert into public.observability_retention_state (singleton_id)
values (1)
on conflict (singleton_id) do nothing;

alter table public.observability_retention_state enable row level security;
alter table public.observability_retention_state force row level security;
revoke all on table public.observability_retention_state
  from public, anon, authenticated, service_role;

create or replace function public.get_observability_retention_state_v1()
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
  last_deleted_container_rollups bigint
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
    state.last_deleted_container_rollups
  from public.observability_retention_state as state
  where state.singleton_id = 1;
$$;

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

  -- Container Sampleは対応する5分Rollupが存在するものだけ削除する。
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

  -- Minecraft Sampleは現時点で長期Rollupを持たないため、Raw保持期間だけ保存する。
  with candidates as (
    select samples.id
    from public.minecraft_samples as samples
    where samples.received_at < v_raw_cutoff
    order by samples.received_at, samples.id
    limit v_batch_size
  ), deleted as (
    delete from public.minecraft_samples as samples
    using candidates
    where samples.id = candidates.id
    returning samples.id
  )
  select count(*) into v_deleted_minecraft from deleted;

  -- HeartbeatはHost Rollupが存在し、削除対象外の子Sampleが残っていないものだけ削除する。
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

  update public.observability_retention_state as state
  set last_run_at = clock_timestamp(),
      last_raw_cutoff = v_raw_cutoff,
      last_rollup_cutoff = v_rollup_cutoff,
      last_deleted_container_samples = v_deleted_container,
      last_deleted_minecraft_samples = v_deleted_minecraft,
      last_deleted_heartbeats = v_deleted_heartbeats,
      last_deleted_host_rollups = v_deleted_host_rollups,
      last_deleted_container_rollups = v_deleted_container_rollups,
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

create or replace function public.configure_observability_retention_v1(
  p_enabled boolean,
  p_raw_retention_days integer default 7,
  p_rollup_retention_days integer default 90,
  p_batch_size integer default 50000
)
returns table (
  enabled boolean,
  raw_retention_days integer,
  rollup_retention_days integer,
  batch_size integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, cron
as $$
declare
  v_job_id bigint;
begin
  if p_enabled is null
     or p_raw_retention_days not between 2 and 45
     or p_rollup_retention_days not between 31 and 730
     or p_rollup_retention_days < greatest(p_raw_retention_days, 31)
     or p_batch_size not between 1000 and 100000 then
    raise exception 'observability_retention_configuration_invalid'
      using errcode = '22023';
  end if;

  update public.observability_retention_state as state
  set enabled = p_enabled,
      raw_retention_days = p_raw_retention_days,
      rollup_retention_days = p_rollup_retention_days,
      batch_size = p_batch_size,
      updated_at = clock_timestamp()
  where state.singleton_id = 1;

  for v_job_id in
    select jobid from cron.job
    where jobname = 'ivrm-observability-retention-v1'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  if p_enabled then
    perform cron.schedule(
      'ivrm-observability-retention-v1',
      '17 */6 * * *',
      'select public.run_observability_retention_v1();'
    );
  end if;

  return query select
    state.enabled,
    state.raw_retention_days,
    state.rollup_retention_days,
    state.batch_size
  from public.observability_retention_state as state
  where state.singleton_id = 1;
end;
$$;

revoke all on function public.get_observability_retention_state_v1()
  from public, anon, authenticated;
grant execute on function public.get_observability_retention_state_v1()
  to service_role;

revoke all on function public.run_observability_retention_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.configure_observability_retention_v1(boolean, integer, integer, integer)
  from public, anon, authenticated, service_role;

comment on table public.observability_retention_state is
  '監視Raw/5分RollupのRetention設定と直近実行結果。初期状態は無効。';
comment on function public.get_observability_retention_state_v1() is
  'Server側UI向けにRetention設定と直近成功実行結果だけを返す。';
comment on function public.run_observability_retention_v1() is
  'Rollup確認済みRawを上限制御付きで削除する内部Retention Job。';
comment on function public.configure_observability_retention_v1(boolean, integer, integer, integer) is
  'DB管理者専用。Retentionを有効/無効化し、6時間ごとのpg_cronを登録/解除する。';

-- Migration適用だけでは削除を開始しない。PR merge後のProduction確認後に明示的に有効化する。
do $$
declare
  v_job_id bigint;
begin
  update public.observability_retention_state
  set enabled = false,
      updated_at = clock_timestamp()
  where singleton_id = 1;

  for v_job_id in
    select jobid from cron.job
    where jobname = 'ivrm-observability-retention-v1'
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;