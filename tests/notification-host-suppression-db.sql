-- Issue #218: host heartbeat suppression while the Console ingest is
-- known to be disabled. Runs after cloud-monitor-db.sql in the same
-- session (console_ingest_health exists via 202611140001). The preamble
-- adds minimal stand-ins for the host-side tables and the enqueue
-- helper that the full notification migrations would normally provide.

alter table public.hosts
  add column if not exists display_name text not null default 'host';

create table if not exists public.agent_heartbeats (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  received_at timestamptz not null
);

create table if not exists public.backup_policies (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.hosts(id) on delete cascade,
  backup_target text not null,
  game_mode text not null,
  backup_type text not null,
  remote_sync_required boolean not null default false,
  warning_after_seconds integer not null default 0,
  critical_after_seconds integer not null default 0,
  remote_sync_warning_seconds integer not null default 0,
  restore_test_warning_seconds integer not null default 0,
  enabled boolean not null default true
);

create table if not exists public.backup_runs (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  backup_target text not null,
  game_mode text not null,
  backup_type text not null,
  outcome text not null,
  completed_at timestamptz,
  remote_synced_at timestamptz,
  restore_tested_at timestamptz,
  retention_expires_at timestamptz
);

update public.notification_channels
set enabled = true, configured = true
where id = 1;

create or replace function public.enqueue_notification_v1(
  p_dedupe_key text,
  p_signal_key text,
  p_source_type text,
  p_host_id uuid,
  p_server_id text,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_transition text,
  p_severity text,
  p_title text,
  p_message text,
  p_detail_href text,
  p_occurred_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_suppression_reason text;
  v_id bigint;
begin
  v_suppression_reason := public.notification_suppression_reason_v1(
    p_host_id, p_entity_type, p_entity_key, p_entity_name,
    coalesce(p_signal_key, p_dedupe_key), p_occurred_at
  );

  insert into public.notification_outbox (
    dedupe_key, signal_key, source_type, host_id, server_id, entity_type,
    entity_key, entity_name, transition, severity, title, message,
    detail_href, occurred_at, status, suppression_reason
  ) values (
    p_dedupe_key, p_signal_key, p_source_type, p_host_id, p_server_id,
    p_entity_type, p_entity_key, p_entity_name, p_transition, p_severity,
    p_title, p_message, p_detail_href, p_occurred_at,
    case when v_suppression_reason is null then 'pending' else 'suppressed' end,
    v_suppression_reason
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select outbox.id into v_id
    from public.notification_outbox as outbox
    where outbox.dedupe_key = p_dedupe_key;
  end if;

  return v_id;
end;
$$;

insert into public.hosts (id, server_id, display_name, enabled)
values ('aaaaaaaa-1111-4111-8111-111111111111', 'host-a', 'Host A', true)
on conflict (id) do nothing;

-- The seed heartbeat is 400 seconds old: past both the issue
-- #230 thresholds (warning >150s, critical >300s) that migration
-- 202611140004 installs earlier in this chain.
insert into public.agent_heartbeats (host_id, received_at)
values ('aaaaaaaa-1111-4111-8111-111111111111', clock_timestamp() - interval '400 seconds');

create temporary table host_suppression_baseline (
  label text primary key,
  outbox_count integer not null
) on commit drop;

create or replace function pg_temp.host_outbox_count()
returns integer
language sql
as $$
  select count(*)::integer
  from public.notification_outbox
  where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat';
$$;

create or replace function pg_temp.host_reset()
returns void
language plpgsql
as $$
begin
  delete from public.notification_outbox
  where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat';
  delete from public.notification_signal_state
  where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat';
  delete from public.agent_heartbeats
  where host_id = 'aaaaaaaa-1111-4111-8111-111111111111';
  insert into public.agent_heartbeats (host_id, received_at)
  values ('aaaaaaaa-1111-4111-8111-111111111111', clock_timestamp() - interval '400 seconds');
end;
$$;

-- Scenario 0 (issue #230 thresholds): at 200 seconds of age the
-- warning threshold (150s) has passed but the critical threshold
-- (300s) has not: exactly one opened warning, no escalation.
-- Under the pre-#230 thresholds (45/180) this age escalated too.
update public.agent_heartbeats
set received_at = clock_timestamp() - interval '200 seconds'
where host_id = 'aaaaaaaa-1111-4111-8111-111111111111';
delete from public.console_ingest_health;
select public.reconcile_notification_scheduled_signals_v1();

do $$
begin
  if pg_temp.host_outbox_count() <> 1 then
    raise exception 'scenario 0: expected exactly 1 outbox row (opened warning) at 200s age, got %', pg_temp.host_outbox_count();
  end if;
  if not exists (
    select 1 from public.notification_signal_state
    where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat'
      and active and severity = 'warning'
  ) then
    raise exception 'scenario 0: signal state is not active/warning at 200s age';
  end if;
end;
$$;

select pg_temp.host_reset();

-- Scenario 1: no probe row -> baseline behaviour (opened + escalated).
delete from public.console_ingest_health;
select public.reconcile_notification_scheduled_signals_v1();

do $$
begin
  if pg_temp.host_outbox_count() <> 2 then
    raise exception 'scenario 1: expected opened+escalated without probe, got %', pg_temp.host_outbox_count();
  end if;
end;
$$;

-- Scenario 2: fresh disabled probe -> silent tracking, no resends.
select pg_temp.host_reset();
select public.record_console_ingest_health_v1(402, true, 'test');
select public.reconcile_notification_scheduled_signals_v1();
select public.reconcile_notification_scheduled_signals_v1();

do $$
declare
  v_state public.notification_signal_state%rowtype;
begin
  select * into v_state
  from public.notification_signal_state
  where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat';

  if not found or not v_state.active or v_state.severity <> 'critical' then
    raise exception 'scenario 2: signal must be tracked active/critical while suppressed';
  end if;

  if pg_temp.host_outbox_count() <> 0 then
    raise exception 'scenario 2: expected zero notifications while suppressed, got %', pg_temp.host_outbox_count();
  end if;
end;
$$;

-- Scenario 3: silent episode recovers silently.
insert into public.agent_heartbeats (host_id, received_at)
values ('aaaaaaaa-1111-4111-8111-111111111111', clock_timestamp());
select public.reconcile_notification_scheduled_signals_v1();

do $$
declare
  v_state public.notification_signal_state%rowtype;
begin
  select * into v_state
  from public.notification_signal_state
  where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat';

  if not found or v_state.active then
    raise exception 'scenario 3: signal must be recovered';
  end if;

  if pg_temp.host_outbox_count() <> 0 then
    raise exception 'scenario 3: silent episode must recover silently, got % rows', pg_temp.host_outbox_count();
  end if;
end;
$$;

-- Scenario 4: suppressed opening, probe goes stale -> one catch-up
-- opened carrying the current (critical) severity, then no resends.
select pg_temp.host_reset();
select public.record_console_ingest_health_v1(402, true, 'test');
select public.reconcile_notification_scheduled_signals_v1();

update public.console_ingest_health
set checked_at = clock_timestamp() - interval '11 minutes'
where id = 1;

select public.reconcile_notification_scheduled_signals_v1();
select public.reconcile_notification_scheduled_signals_v1();

do $$
declare
  v_opened integer;
  v_severity text;
begin
  select count(*), max(severity) into v_opened, v_severity
  from public.notification_outbox
  where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat'
    and transition = 'opened';

  if pg_temp.host_outbox_count() <> 1 or v_opened <> 1 or v_severity <> 'critical' then
    raise exception 'scenario 4: expected exactly one catch-up opened (critical), got total=% opened=% severity=%',
      pg_temp.host_outbox_count(), v_opened, v_severity;
  end if;
end;
$$;

-- Scenario 5: the announced episode then recovers with a notification.
insert into public.agent_heartbeats (host_id, received_at)
values ('aaaaaaaa-1111-4111-8111-111111111111', clock_timestamp());
select public.reconcile_notification_scheduled_signals_v1();

do $$
begin
  if not exists (
    select 1
    from public.notification_outbox
    where signal_key = 'host:aaaaaaaa-1111-4111-8111-111111111111:heartbeat'
      and transition = 'recovered'
  ) then
    raise exception 'scenario 5: announced episode must announce its recovery';
  end if;
end;
$$;

-- Scenario 6: probe row deleted -> suppression must not engage.
select pg_temp.host_reset();
delete from public.console_ingest_health;
select public.reconcile_notification_scheduled_signals_v1();

do $$
begin
  if pg_temp.host_outbox_count() <> 2 then
    raise exception 'scenario 6: without a probe the baseline behaviour applies, got %', pg_temp.host_outbox_count();
  end if;
end;
$$;

select 'host heartbeat suppression contracts passed' as result;
