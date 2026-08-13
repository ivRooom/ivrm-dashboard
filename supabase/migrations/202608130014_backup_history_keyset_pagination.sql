create or replace function public.get_backup_runs_v2(
  p_range text default '24h',
  p_limit integer default 500,
  p_before_started_at timestamptz default null,
  p_before_id bigint default null
)
returns table (
  row_id bigint,
  run_id uuid,
  host_id uuid,
  server_id text,
  host_display_name text,
  backup_target text,
  game_mode text,
  backup_type text,
  destination_type text,
  started_at timestamptz,
  completed_at timestamptz,
  outcome text,
  duration_seconds integer,
  size_bytes bigint,
  sha256_verified boolean,
  remote_synced_at timestamptz,
  restore_tested_at timestamptz,
  retention_expires_at timestamptz,
  failure_code text
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_since timestamptz;
begin
  if p_range not in ('24h', '7d', '30d')
    or p_limit is null
    or p_limit < 1
    or p_limit > 500
    or ((p_before_started_at is null) <> (p_before_id is null)) then
    raise exception 'backup_history_query_invalid' using errcode = '22023';
  end if;

  v_since := statement_timestamp() - case p_range
    when '24h' then interval '24 hours'
    when '7d' then interval '7 days'
    else interval '30 days'
  end;

  return query
  select
    runs.id,
    runs.run_id,
    runs.host_id,
    hosts.server_id,
    hosts.display_name,
    runs.backup_target,
    runs.game_mode,
    runs.backup_type,
    runs.destination_type,
    runs.started_at,
    runs.completed_at,
    runs.outcome,
    runs.duration_seconds,
    runs.size_bytes,
    runs.sha256_verified,
    runs.remote_synced_at,
    runs.restore_tested_at,
    runs.retention_expires_at,
    runs.failure_code
  from public.backup_runs as runs
  join public.hosts as hosts on hosts.id = runs.host_id
  where coalesce(runs.completed_at, runs.started_at) >= v_since
    and (
      p_before_started_at is null
      or (runs.started_at, runs.id) < (p_before_started_at, p_before_id)
    )
  order by runs.started_at desc, runs.id desc
  limit p_limit;
end;
$$;

revoke all on function public.get_backup_runs_v2(text, integer, timestamptz, bigint)
  from public, anon, authenticated;
grant execute on function public.get_backup_runs_v2(text, integer, timestamptz, bigint)
  to service_role;

comment on function public.get_backup_runs_v2(text, integer, timestamptz, bigint) is
  '24h/7d/30dのBackup履歴を(started_at,id) Cursorで最大500件ずつ返し、Web側の全件走査を可能にする。';
