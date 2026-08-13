create or replace function public.get_backup_incident_context_v1(
  p_before timestamptz
)
returns table (
  host_id uuid,
  server_id text,
  host_display_name text,
  backup_target text,
  game_mode text,
  backup_type text,
  failure_started_at timestamptz,
  consecutive_failure_count integer,
  checksum_started_at timestamptz,
  related_run_count integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
begin
  if p_before is null
     or p_before > statement_timestamp() + interval '5 minutes'
     or p_before < statement_timestamp() - interval '3650 days' then
    raise exception 'backup_incident_context_query_invalid' using errcode = '22023';
  end if;

  return query
  with targets as (
    select
      policies.host_id,
      hosts.server_id,
      hosts.display_name as host_display_name,
      policies.backup_target,
      policies.game_mode,
      policies.backup_type,
      (
        select max(runs.completed_at)
        from public.backup_runs as runs
        where runs.host_id = policies.host_id
          and runs.backup_target = policies.backup_target
          and runs.game_mode = policies.game_mode
          and runs.backup_type = policies.backup_type
          and runs.outcome = 'success'
          and runs.completed_at < p_before
      ) as last_success_at,
      (
        select max(runs.completed_at)
        from public.backup_runs as runs
        where runs.host_id = policies.host_id
          and runs.backup_target = policies.backup_target
          and runs.game_mode = policies.game_mode
          and runs.backup_type = policies.backup_type
          and runs.outcome = 'success'
          and runs.sha256_verified is true
          and runs.completed_at < p_before
      ) as last_checksum_recovery_at
    from public.backup_policies as policies
    join public.hosts as hosts on hosts.id = policies.host_id
    where policies.enabled
  ),
  signal_state as (
    select
      targets.*,
      failure.failure_started_at,
      coalesce(failure.consecutive_failure_count, 0)::integer as consecutive_failure_count,
      checksum.checksum_started_at
    from targets
    left join lateral (
      select
        min(runs.completed_at) as failure_started_at,
        count(*)::integer as consecutive_failure_count
      from public.backup_runs as runs
      where runs.host_id = targets.host_id
        and runs.backup_target = targets.backup_target
        and runs.game_mode = targets.game_mode
        and runs.backup_type = targets.backup_type
        and runs.outcome = 'failed'
        and runs.completed_at < p_before
        and (
          targets.last_success_at is null
          or runs.completed_at > targets.last_success_at
        )
    ) as failure on true
    left join lateral (
      select min(runs.completed_at) as checksum_started_at
      from public.backup_runs as runs
      where runs.host_id = targets.host_id
        and runs.backup_target = targets.backup_target
        and runs.game_mode = targets.game_mode
        and runs.backup_type = targets.backup_type
        and runs.completed_at < p_before
        and (
          targets.last_checksum_recovery_at is null
          or runs.completed_at > targets.last_checksum_recovery_at
        )
        and (
          runs.failure_code = 'checksum_failed'
          or (runs.outcome = 'success' and runs.sha256_verified is false)
        )
    ) as checksum on true
  )
  select
    state.host_id,
    state.server_id,
    state.host_display_name,
    state.backup_target,
    state.game_mode,
    state.backup_type,
    state.failure_started_at,
    state.consecutive_failure_count,
    state.checksum_started_at,
    (
      select count(*)::integer
      from public.backup_runs as runs
      where runs.host_id = state.host_id
        and runs.backup_target = state.backup_target
        and runs.game_mode = state.game_mode
        and runs.backup_type = state.backup_type
        and runs.completed_at < p_before
        and runs.completed_at >= case
          when state.failure_started_at is null then state.checksum_started_at
          when state.checksum_started_at is null then state.failure_started_at
          else least(state.failure_started_at, state.checksum_started_at)
        end
        and runs.outcome in ('success', 'failed')
    ) as related_run_count
  from signal_state as state
  where state.failure_started_at is not null
     or state.checksum_started_at is not null
  order by
    least(
      coalesce(state.failure_started_at, 'infinity'::timestamptz),
      coalesce(state.checksum_started_at, 'infinity'::timestamptz)
    ),
    state.host_id,
    state.backup_target,
    state.game_mode,
    state.backup_type;
end;
$$;

revoke all on function public.get_backup_incident_context_v1(timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_backup_incident_context_v1(timestamptz)
  to service_role;

comment on function public.get_backup_incident_context_v1(timestamptz) is
  '指定境界より前から継続しているBackup Run failure / Checksum failureシグナルをTarget単位で返し、Incident復旧Durationの開始Contextを保持する。';
