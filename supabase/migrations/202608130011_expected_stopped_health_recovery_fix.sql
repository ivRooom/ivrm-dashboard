-- Incident Center review follow-up:
-- expected_state=stopped/absentではHealth / ExitCode変化はIncident openerにならないため、
-- 正常値へ戻ったTransitionだけをrecoveryとして保存しない。

create or replace function public.classify_container_monitoring_event_v2(
  p_expected_state text,
  p_event_type text,
  p_from_value text,
  p_to_value text,
  p_numeric_value bigint default null,
  p_maintenance_active boolean default false
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
begin
  if p_event_type in ('maintenance_started', 'maintenance_ended') then
    return 'info';
  end if;

  if p_event_type = 'oom_killed' then
    return 'critical';
  end if;

  if p_maintenance_active then
    return 'info';
  end if;

  -- stopped / absentではHealthとExitCodeは正常性判定のSignalにしないため、
  -- openerのないrecoveryを作らない。
  if p_event_type = 'health_changed'
     and p_expected_state is distinct from 'stopped'
     and p_expected_state is distinct from 'absent'
     and p_to_value = 'healthy'
     and p_from_value in ('unhealthy', 'starting', 'unknown') then
    return 'recovery';
  end if;

  if p_event_type = 'state_changed'
     and p_expected_state is distinct from 'stopped'
     and p_expected_state is distinct from 'absent'
     and p_to_value = 'running'
     and p_from_value is distinct from 'running' then
    return 'recovery';
  end if;

  if p_event_type = 'exit_code_changed'
     and p_expected_state is distinct from 'stopped'
     and p_expected_state is distinct from 'absent'
     and p_from_value is not null
     and p_from_value ~ '^-?[0-9]+$'
     and p_from_value::bigint <> 0
     and p_to_value is not null
     and p_to_value ~ '^-?[0-9]+$'
     and p_to_value::bigint = 0 then
    return 'recovery';
  end if;

  if p_event_type = 'restart_count_increased' then
    return 'warning';
  end if;

  if p_expected_state = 'stopped' then
    if p_event_type = 'state_changed' and p_to_value = 'running' then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_expected_state = 'absent' then
    if p_event_type = 'state_changed' and p_to_value = 'not_found' then
      return 'info';
    end if;
    if p_event_type = 'state_changed' then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_event_type = 'health_changed' then
    if p_to_value = 'unhealthy' then
      return 'critical';
    end if;
    if p_to_value in ('starting', 'unknown') then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_event_type = 'state_changed' then
    if p_to_value in ('dead', 'exited', 'not_found', 'removing', 'unknown') then
      return 'critical';
    end if;
    if p_to_value in ('restarting', 'paused', 'created') then
      return 'warning';
    end if;
    return 'info';
  end if;

  if p_event_type = 'exit_code_changed' then
    if p_to_value is not null
       and p_to_value ~ '^-?[0-9]+$'
       and p_to_value::bigint <> 0 then
      return 'critical';
    end if;
  end if;

  return 'info';
end;
$$;

revoke all on function public.classify_container_monitoring_event_v2(
  text, text, text, text, bigint, boolean
) from public, anon, authenticated, service_role;

-- 過去にopenerなしでrecoveryへ分類されたstopped/absentのHealth/Exit正常化を補正する。
update public.monitoring_events
set severity = 'info'
where severity = 'recovery'
  and expected_state in ('stopped', 'absent')
  and (
    (event_type = 'health_changed' and to_value = 'healthy')
    or (
      event_type = 'exit_code_changed'
      and to_value is not null
      and to_value ~ '^-?[0-9]+$'
      and to_value::bigint = 0
    )
  );

comment on function public.classify_container_monitoring_event_v2(
  text, text, text, text, bigint, boolean
) is 'Container監視イベントのSeverity分類。Maintenanceとstopped/absentの非対象SignalではopenerのないRecoveryを生成しない';
