-- Issue #235: backup-signal suppression while the Console ingest is
-- known to be disabled (extends the Issue #218 heartbeat suppression).
-- Runs after tests/notification-host-suppression-db.sql in the same
-- session, reusing its stand-in tables.

insert into public.hosts (id, server_id, display_name, enabled)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'backup-host', 'Backup Host', true)
on conflict (id) do nothing;

-- A policy whose latest successful run finished 3 hours ago: past the
-- warning SLA (1h) and the critical SLA (2h). Remote sync is not
-- required, retention is far in the future, and the restore-test SLA
-- is huge, so only backup_age can fire.
insert into public.backup_policies (
  host_id, backup_target, game_mode, backup_type, remote_sync_required,
  warning_after_seconds, critical_after_seconds,
  remote_sync_warning_seconds, restore_test_warning_seconds, enabled
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bkp-target', 'main', 'full', false,
  3600, 7200, 3600, 315360000, true
);

insert into public.backup_runs (
  host_id, backup_target, game_mode, backup_type, outcome,
  completed_at, remote_synced_at, restore_tested_at, retention_expires_at
) values (
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'bkp-target', 'main', 'full', 'success',
  clock_timestamp() - interval '3 hours', null, null,
  clock_timestamp() + interval '30 days'
);

-- During the outage the backup_age state is tracked (active, critical)
-- but nothing is enqueued.
select public.record_console_ingest_health_v1(402, true, 'test');
select public.reconcile_notification_scheduled_signals_v1();

do $$
begin
  if not exists (
    select 1 from public.notification_signal_state
    where signal_key = 'backup:cccccccc-cccc-4ccc-8ccc-cccccccccccc:bkp-target:main:full:backup_age'
      and active and severity = 'critical'
  ) then
    raise exception 'backup_age state must be tracked as critical during the outage';
  end if;
  if exists (
    select 1 from public.notification_outbox
    where signal_key like 'backup:cccccccc-cccc-4ccc-8ccc-cccccccccccc:%' and status = 'pending'
  ) then
    raise exception 'backup notifications must be suppressed during the outage';
  end if;
end;
$$;

-- After ingest recovers, the still-active episode announces itself
-- exactly once, as a critical catch-up.
delete from public.console_ingest_health;
select public.record_console_ingest_health_v1(200, false, 'test');
select public.reconcile_notification_scheduled_signals_v1();
select public.reconcile_notification_scheduled_signals_v1();

do $$
declare
  v_opened integer;
begin
  select count(*) into v_opened from public.notification_outbox
  where signal_key = 'backup:cccccccc-cccc-4ccc-8ccc-cccccccccccc:bkp-target:main:full:backup_age'
    and transition = 'opened' and status = 'pending';
  if v_opened <> 1 then
    raise exception 'backup_age catch-up opened: expected 1, got %', v_opened;
  end if;
  if not exists (
    select 1 from public.notification_outbox
    where signal_key = 'backup:cccccccc-cccc-4ccc-8ccc-cccccccccccc:bkp-target:main:full:backup_age'
      and transition = 'opened' and title like '重大化:%'
  ) then
    raise exception 'backup_age catch-up must carry the critical title prefix';
  end if;
end;
$$;

select 'backup signal suppression contracts passed' as result;
