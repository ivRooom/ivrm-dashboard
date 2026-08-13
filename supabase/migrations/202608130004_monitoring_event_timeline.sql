create table if not exists public.monitoring_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  host_id uuid not null references public.hosts(id) on delete cascade,
  container_name text not null,
  occurred_at timestamptz not null,
  event_type text not null,
  severity text not null,
  from_value text,
  to_value text,
  numeric_value bigint,
  expected_state text,
  sample_id bigint references public.container_samples(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  constraint monitoring_events_key_check check (char_length(event_key) between 1 and 320),
  constraint monitoring_events_container_check check (
    char_length(container_name) between 1 and 128
    and container_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
  ),
  constraint monitoring_events_type_check check (event_type in (
    'state_changed',
    'health_changed',
    'restart_count_increased',
    'oom_killed',
    'exit_code_changed',
    'maintenance_started',
    'maintenance_ended'
  )),
  constraint monitoring_events_severity_check check (
    severity in ('info', 'warning', 'critical', 'recovery')
  ),
  constraint monitoring_events_from_check check (
    from_value is null or char_length(from_value) <= 128
  ),
  constraint monitoring_events_to_check check (
    to_value is null or char_length(to_value) <= 128
  ),
  constraint monitoring_events_expected_check check (
    expected_state is null or expected_state in ('running', 'stopped', 'absent')
  )
);

create index if not exists monitoring_events_occurred_at_idx
  on public.monitoring_events (occurred_at desc);
create index if not exists monitoring_events_container_time_idx
  on public.monitoring_events (host_id, container_name, occurred_at desc);
create index if not exists monitoring_events_severity_time_idx
  on public.monitoring_events (severity, occurred_at desc);

alter table public.monitoring_events enable row level security;
alter table public.monitoring_events force row level security;

revoke all on table public.monitoring_events
  from public, anon, authenticated, service_role;
revoke all on sequence public.monitoring_events_id_seq
  from public, anon, authenticated, service_role;

drop policy if exists "deny_monitoring_events_public_access"
  on public.monitoring_events;
create policy "deny_monitoring_events_public_access"
on public.monitoring_events
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

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

  -- OOMはMaintenance中でも見逃さない。
  if p_event_type = 'oom_killed' then
    return 'critical';
  end if;

  -- 計画Maintenance中の停止・Health変化・Restart等はIncident扱いしない。
  if p_maintenance_active then
    return 'info';
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
    if p_to_value = 'healthy'
       and p_from_value in ('unhealthy', 'starting', 'unknown') then
      return 'recovery';
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
    if p_to_value = 'running' and p_from_value is distinct from 'running' then
      return 'recovery';
    end if;
    return 'info';
  end if;

  if p_event_type = 'exit_code_changed' then
    if p_to_value is not null
       and p_to_value ~ '^-?[0-9]+$'
       and p_to_value::bigint <> 0 then
      return 'critical';
    end if;
    if p_from_value is not null
       and p_from_value ~ '^-?[0-9]+$'
       and p_from_value::bigint <> 0
       and coalesce(p_to_value, '0') = '0' then
      return 'recovery';
    end if;
  end if;

  return 'info';
end;
$$;

revoke all on function public.classify_container_monitoring_event_v2(
  text, text, text, text, bigint, boolean
) from public, anon, authenticated, service_role;

create or replace function public.capture_container_monitoring_events()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_previous public.container_samples%rowtype;
  v_expected_state text;
  v_maintenance_mode boolean := false;
  v_maintenance_until timestamptz;
  v_maintenance_active boolean := false;
  v_severity text;
begin
  select samples.*
  into v_previous
  from public.container_samples as samples
  where samples.host_id = new.host_id
    and samples.container_name = new.container_name
    and samples.received_at < new.received_at
    and samples.id <> new.id
  order by samples.received_at desc, samples.id desc
  limit 1;

  if not found then
    return new;
  end if;

  select
    expectations.expected_state,
    expectations.maintenance_mode,
    expectations.maintenance_until
  into
    v_expected_state,
    v_maintenance_mode,
    v_maintenance_until
  from public.container_expectations as expectations
  where expectations.host_id = new.host_id
    and expectations.container_name = new.container_name;

  v_maintenance_active := coalesce(v_maintenance_mode, false)
    and (v_maintenance_until is null or v_maintenance_until > new.received_at);

  if new.state is distinct from v_previous.state then
    v_severity := public.classify_container_monitoring_event_v2(
      v_expected_state,
      'state_changed',
      v_previous.state,
      new.state,
      null,
      v_maintenance_active
    );
    insert into public.monitoring_events (
      event_key, host_id, container_name, occurred_at, event_type, severity,
      from_value, to_value, expected_state, sample_id
    ) values (
      'sample:' || new.id || ':state',
      new.host_id,
      new.container_name,
      new.received_at,
      'state_changed',
      v_severity,
      v_previous.state,
      new.state,
      v_expected_state,
      new.id
    ) on conflict (event_key) do nothing;
  end if;

  if new.health is distinct from v_previous.health then
    v_severity := public.classify_container_monitoring_event_v2(
      v_expected_state,
      'health_changed',
      v_previous.health,
      new.health,
      null,
      v_maintenance_active
    );
    insert into public.monitoring_events (
      event_key, host_id, container_name, occurred_at, event_type, severity,
      from_value, to_value, expected_state, sample_id
    ) values (
      'sample:' || new.id || ':health',
      new.host_id,
      new.container_name,
      new.received_at,
      'health_changed',
      v_severity,
      v_previous.health,
      new.health,
      v_expected_state,
      new.id
    ) on conflict (event_key) do nothing;
  end if;

  if new.restart_count > v_previous.restart_count then
    v_severity := public.classify_container_monitoring_event_v2(
      v_expected_state,
      'restart_count_increased',
      v_previous.restart_count::text,
      new.restart_count::text,
      (new.restart_count - v_previous.restart_count)::bigint,
      v_maintenance_active
    );
    insert into public.monitoring_events (
      event_key, host_id, container_name, occurred_at, event_type, severity,
      from_value, to_value, numeric_value, expected_state, sample_id
    ) values (
      'sample:' || new.id || ':restart',
      new.host_id,
      new.container_name,
      new.received_at,
      'restart_count_increased',
      v_severity,
      v_previous.restart_count::text,
      new.restart_count::text,
      (new.restart_count - v_previous.restart_count)::bigint,
      v_expected_state,
      new.id
    ) on conflict (event_key) do nothing;
  end if;

  if not v_previous.oom_killed and new.oom_killed then
    insert into public.monitoring_events (
      event_key, host_id, container_name, occurred_at, event_type, severity,
      from_value, to_value, expected_state, sample_id
    ) values (
      'sample:' || new.id || ':oom',
      new.host_id,
      new.container_name,
      new.received_at,
      'oom_killed',
      'critical',
      'false',
      'true',
      v_expected_state,
      new.id
    ) on conflict (event_key) do nothing;
  end if;

  if new.exit_code is distinct from v_previous.exit_code then
    v_severity := public.classify_container_monitoring_event_v2(
      v_expected_state,
      'exit_code_changed',
      v_previous.exit_code::text,
      new.exit_code::text,
      new.exit_code::bigint,
      v_maintenance_active
    );
    insert into public.monitoring_events (
      event_key, host_id, container_name, occurred_at, event_type, severity,
      from_value, to_value, numeric_value, expected_state, sample_id
    ) values (
      'sample:' || new.id || ':exit',
      new.host_id,
      new.container_name,
      new.received_at,
      'exit_code_changed',
      v_severity,
      v_previous.exit_code::text,
      new.exit_code::text,
      new.exit_code::bigint,
      v_expected_state,
      new.id
    ) on conflict (event_key) do nothing;
  end if;

  return new;
end;
$$;

revoke all on function public.capture_container_monitoring_events()
  from public, anon, authenticated, service_role;

drop trigger if exists capture_container_monitoring_events_after_insert
  on public.container_samples;
create trigger capture_container_monitoring_events_after_insert
after insert on public.container_samples
for each row execute function public.capture_container_monitoring_events();

-- container_expectationsに既存の自動updated_at処理がないため、
-- Maintenanceや期待状態の変更時刻をDB側で確定させる。
create or replace function public.touch_container_expectations_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

revoke all on function public.touch_container_expectations_updated_at()
  from public, anon, authenticated, service_role;

drop trigger if exists touch_container_expectations_updated_at_before_update
  on public.container_expectations;
create trigger touch_container_expectations_updated_at_before_update
before update on public.container_expectations
for each row execute function public.touch_container_expectations_updated_at();

create or replace function public.capture_container_maintenance_event()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_time timestamptz := new.updated_at;
  v_old_active boolean;
  v_new_active boolean;
  v_type text;
  v_key text;
begin
  -- modeだけではなく期限を含む「実効Maintenance状態」を比較する。
  v_old_active := old.maintenance_mode
    and (old.maintenance_until is null or old.maintenance_until > v_time);
  v_new_active := new.maintenance_mode
    and (new.maintenance_until is null or new.maintenance_until > v_time);

  -- 期限切れ後に明示解除された場合、Cronより先に更新されても
  -- 論理終了イベントを期限時刻で取りこぼさない。
  if old.maintenance_mode
     and old.maintenance_until is not null
     and old.maintenance_until <= v_time
     and not new.maintenance_mode then
    insert into public.monitoring_events (
      event_key, host_id, container_name, occurred_at, event_type, severity,
      from_value, to_value, expected_state
    ) values (
      'maintenance-expiry:'
        || old.host_id || ':'
        || old.container_name || ':'
        || extract(epoch from old.maintenance_until)::text,
      old.host_id,
      old.container_name,
      old.maintenance_until,
      'maintenance_ended',
      'info',
      'true',
      'false',
      old.expected_state
    ) on conflict (event_key) do nothing;
  end if;

  if v_old_active is not distinct from v_new_active then
    return new;
  end if;

  v_type := case
    when v_new_active then 'maintenance_started'
    else 'maintenance_ended'
  end;
  v_key := 'expectation-effective:'
    || new.host_id || ':'
    || new.container_name || ':'
    || extract(epoch from v_time)::text || ':'
    || v_type;

  insert into public.monitoring_events (
    event_key, host_id, container_name, occurred_at, event_type, severity,
    from_value, to_value, expected_state
  ) values (
    v_key,
    new.host_id,
    new.container_name,
    v_time,
    v_type,
    'info',
    v_old_active::text,
    v_new_active::text,
    new.expected_state
  ) on conflict (event_key) do nothing;

  return new;
end;
$$;

revoke all on function public.capture_container_maintenance_event()
  from public, anon, authenticated, service_role;

drop trigger if exists capture_container_maintenance_event_after_update
  on public.container_expectations;
create trigger capture_container_maintenance_event_after_update
after update of maintenance_mode, maintenance_until
on public.container_expectations
for each row execute function public.capture_container_maintenance_event();

-- maintenance_mode=trueのまま期限を過ぎても、アプリ上は期限時点でMaintenance終了となる。
-- その論理終了を構造化イベントとして1度だけ記録する。
create or replace function public.capture_expired_container_maintenance_events()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  insert into public.monitoring_events (
    event_key, host_id, container_name, occurred_at, event_type, severity,
    from_value, to_value, expected_state
  )
  select
    'maintenance-expiry:'
      || expectations.host_id || ':'
      || expectations.container_name || ':'
      || extract(epoch from expectations.maintenance_until)::text,
    expectations.host_id,
    expectations.container_name,
    expectations.maintenance_until,
    'maintenance_ended',
    'info',
    'true',
    'false',
    expectations.expected_state
  from public.container_expectations as expectations
  where expectations.maintenance_mode
    and expectations.maintenance_until is not null
    and expectations.maintenance_until <= clock_timestamp()
  on conflict (event_key) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.capture_expired_container_maintenance_events()
  from public, anon, authenticated, service_role;

-- 既存SampleをBackfillする。
-- Expectation履歴テーブルは存在しないため、現在のExpectationの最終更新時刻より
-- 古いSampleへ現在値を遡及しない。Expectationを証明できない期間は
-- expected_state=null / infoとして状態変化の事実だけを保存する。
with ordered as (
  select
    samples.id,
    samples.host_id,
    samples.container_name,
    samples.received_at,
    samples.state,
    samples.health,
    samples.restart_count,
    samples.oom_killed,
    samples.exit_code,
    lag(samples.state) over w as prev_state,
    lag(samples.health) over w as prev_health,
    lag(samples.restart_count) over w as prev_restart_count,
    lag(samples.oom_killed) over w as prev_oom_killed,
    lag(samples.exit_code) over w as prev_exit_code,
    lag(samples.id) over w as prev_id,
    expectations.expected_state as current_expected_state,
    expectations.maintenance_mode as current_maintenance_mode,
    expectations.maintenance_until as current_maintenance_until,
    case
      when expectations.host_id is not null
       and expectations.updated_at <= samples.received_at
        then true
      else false
    end as expectation_known
  from public.container_samples as samples
  left join public.container_expectations as expectations
    on expectations.host_id = samples.host_id
   and expectations.container_name = samples.container_name
  window w as (
    partition by samples.host_id, samples.container_name
    order by samples.received_at, samples.id
  )
), classified as (
  select
    ordered.*,
    case
      when expectation_known then current_expected_state
      else null
    end as backfill_expected_state,
    expectation_known
      and coalesce(current_maintenance_mode, false)
      and (
        current_maintenance_until is null
        or current_maintenance_until > received_at
      ) as backfill_maintenance_active
  from ordered
), event_rows as (
  select
    'sample:' || id || ':state' as event_key,
    host_id,
    container_name,
    received_at as occurred_at,
    'state_changed'::text as event_type,
    case
      when expectation_known then public.classify_container_monitoring_event_v2(
        backfill_expected_state,
        'state_changed',
        prev_state,
        state,
        null,
        backfill_maintenance_active
      )
      else 'info'
    end as severity,
    prev_state::text as from_value,
    state::text as to_value,
    null::bigint as numeric_value,
    backfill_expected_state as expected_state,
    id as sample_id
  from classified
  where prev_id is not null and state is distinct from prev_state

  union all

  select
    'sample:' || id || ':health',
    host_id,
    container_name,
    received_at,
    'health_changed',
    case
      when expectation_known then public.classify_container_monitoring_event_v2(
        backfill_expected_state,
        'health_changed',
        prev_health,
        health,
        null,
        backfill_maintenance_active
      )
      else 'info'
    end,
    prev_health::text,
    health::text,
    null::bigint,
    backfill_expected_state,
    id
  from classified
  where prev_id is not null and health is distinct from prev_health

  union all

  select
    'sample:' || id || ':restart',
    host_id,
    container_name,
    received_at,
    'restart_count_increased',
    case
      when expectation_known then public.classify_container_monitoring_event_v2(
        backfill_expected_state,
        'restart_count_increased',
        prev_restart_count::text,
        restart_count::text,
        (restart_count - prev_restart_count)::bigint,
        backfill_maintenance_active
      )
      else 'info'
    end,
    prev_restart_count::text,
    restart_count::text,
    (restart_count - prev_restart_count)::bigint,
    backfill_expected_state,
    id
  from classified
  where prev_id is not null and restart_count > prev_restart_count

  union all

  select
    'sample:' || id || ':oom',
    host_id,
    container_name,
    received_at,
    'oom_killed',
    'critical',
    'false',
    'true',
    null::bigint,
    backfill_expected_state,
    id
  from classified
  where prev_id is not null
    and prev_oom_killed = false
    and oom_killed = true

  union all

  select
    'sample:' || id || ':exit',
    host_id,
    container_name,
    received_at,
    'exit_code_changed',
    case
      when expectation_known then public.classify_container_monitoring_event_v2(
        backfill_expected_state,
        'exit_code_changed',
        prev_exit_code::text,
        exit_code::text,
        exit_code::bigint,
        backfill_maintenance_active
      )
      else 'info'
    end,
    prev_exit_code::text,
    exit_code::text,
    exit_code::bigint,
    backfill_expected_state,
    id
  from classified
  where prev_id is not null and exit_code is distinct from prev_exit_code
)
insert into public.monitoring_events (
  event_key, host_id, container_name, occurred_at, event_type, severity,
  from_value, to_value, numeric_value, expected_state, sample_id
)
select
  event_key,
  host_id,
  container_name,
  occurred_at,
  event_type,
  severity,
  from_value,
  to_value,
  numeric_value,
  expected_state,
  sample_id
from event_rows
on conflict (event_key) do nothing;

-- Migration時点ですでに期限切れのMaintenanceも1回回収する。
select public.capture_expired_container_maintenance_events();

create or replace function public.get_monitoring_events_v1(
  p_range text,
  p_server_id text default null,
  p_container_name text default null,
  p_severity text default null
)
returns table (
  event_id bigint,
  host_id uuid,
  server_id text,
  host_display_name text,
  container_name text,
  occurred_at timestamptz,
  event_type text,
  severity text,
  from_value text,
  to_value text,
  numeric_value bigint,
  expected_state text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_interval interval;
begin
  v_interval := case p_range
    when '1h' then interval '1 hour'
    when '6h' then interval '6 hours'
    when '24h' then interval '24 hours'
    when '7d' then interval '7 days'
    when '30d' then interval '30 days'
    else null
  end;

  if v_interval is null then
    raise exception 'invalid range';
  end if;

  if p_server_id is not null and (
    char_length(p_server_id) < 1
    or char_length(p_server_id) > 128
    or p_server_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
  ) then
    raise exception 'invalid server id';
  end if;

  if p_container_name is not null and (
    char_length(p_container_name) < 1
    or char_length(p_container_name) > 128
    or p_container_name !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
  ) then
    raise exception 'invalid container name';
  end if;

  if p_severity is not null
     and p_severity not in ('info', 'warning', 'critical', 'recovery') then
    raise exception 'invalid severity';
  end if;

  return query
  select
    events.id,
    events.host_id,
    hosts.server_id,
    hosts.display_name,
    events.container_name,
    events.occurred_at,
    events.event_type,
    events.severity,
    events.from_value,
    events.to_value,
    events.numeric_value,
    events.expected_state
  from public.monitoring_events as events
  join public.hosts as hosts
    on hosts.id = events.host_id
  where events.occurred_at >= clock_timestamp() - v_interval
    and (p_server_id is null or hosts.server_id = p_server_id)
    and (p_container_name is null or events.container_name = p_container_name)
    and (p_severity is null or events.severity = p_severity)
  order by events.occurred_at desc, events.id desc
  limit 500;
end;
$$;

revoke all on function public.get_monitoring_events_v1(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.get_monitoring_events_v1(text, text, text, text)
  to service_role;

-- pg_cronが有効な環境では1分ごとに期限切れMaintenanceをイベント化する。
do $$
declare
  v_jobid bigint;
begin
  if exists (
    select 1 from pg_extension where extname = 'pg_cron'
  ) then
    for v_jobid in
      select jobid
      from cron.job
      where jobname = 'ivrm-maintenance-expiry-events'
    loop
      perform cron.unschedule(v_jobid);
    end loop;

    perform cron.schedule(
      'ivrm-maintenance-expiry-events',
      '* * * * *',
      'select public.capture_expired_container_maintenance_events();'
    );
  end if;
end;
$$;

comment on table public.monitoring_events is
  'Docker状態変化をSecret非含有の構造化イベントとして保存する監視タイムライン';
comment on function public.get_monitoring_events_v1(text, text, text, text) is
  '許可済み期間・Host・Container・Severityで最大500件の監視イベントを返すService Role専用RPC';
comment on function public.capture_expired_container_maintenance_events() is
  'maintenance_untilを過ぎた計画Maintenanceの論理終了イベントを冪等に記録する内部Job';
