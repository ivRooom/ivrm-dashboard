\set ON_ERROR_STOP on
-- Issue #215: full ingest outage grouping, first-time-only delivery and
-- free-tier pause labelling. Runs after tests/cloud-monitor-db.sql in
-- the same database (hosts collector-a / collector-b, targets aws-app /
-- oci-mc already exist; aws-app ends that test disabled).
do $$
declare
  v_opened_before bigint;
  v_outbox_before bigint;
begin
  -- Reset to a clean, fully healthy two-target state.
  update public.cloud_monitor_targets
     set enabled = true, status = 'operational', reason_code = 'ok',
         received_at = clock_timestamp()
   where id in ('aws-app', 'oci-mc');
  perform public.reconcile_cloud_monitor_signals_v1();
  if exists (select 1 from public.notification_signal_state
             where signal_key in ('cloud:state:aws-app', 'cloud:state:oci-mc', 'cloud:ingest-outage')
               and active) then
    raise exception 'baseline still has active cloud signals';
  end if;

  -- 1. Both targets go stale with no probe data: exactly one grouped
  --    opened notification, no per-target opened notifications, and the
  --    grouped message must not claim a detected cause.
  update public.cloud_monitor_targets
     set received_at = clock_timestamp() - interval '901 seconds'
   where id in ('aws-app', 'oci-mc');
  select count(*) into v_opened_before
    from public.notification_outbox
   where source_type = 'cloud' and transition = 'opened' and status = 'pending';
  perform public.reconcile_cloud_monitor_signals_v1();
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'cloud:ingest-outage' and active
                   and severity = 'critical'
                   and reason like 'collector_ingest_outage:%') then
    raise exception 'grouped outage signal did not open';
  end if;
  if (select message from public.notification_outbox
       where signal_key = 'cloud:ingest-outage' and transition = 'opened'
       order by id desc limit 1) like '%DEPLOYMENT_DISABLED%' then
    raise exception 'grouped message claimed a cause without probe data';
  end if;
  if (select count(*) from public.notification_outbox
       where source_type = 'cloud' and transition = 'opened' and status = 'pending')
     <> v_opened_before + 1 then
    raise exception 'outage did not produce exactly one new opened notification';
  end if;
  if exists (select 1 from public.notification_outbox
             where signal_key in ('cloud:state:aws-app', 'cloud:state:oci-mc')
               and transition = 'opened' and status = 'pending'
               and occurred_at >= (select opened_at from public.notification_signal_state
                                   where signal_key = 'cloud:ingest-outage')) then
    raise exception 'per-target notification leaked during grouped outage';
  end if;
  if not exists (select 1 from public.notification_signal_state
                 where signal_key = 'cloud:state:aws-app' and active) then
    raise exception 'per-target signal was not tracked silently';
  end if;

  -- 2. Re-evaluating an unchanged outage sends nothing more.
  select count(*) into v_outbox_before from public.notification_outbox;
  perform public.reconcile_cloud_monitor_signals_v1();
  if (select count(*) from public.notification_outbox) <> v_outbox_before then
    raise exception 'unchanged outage re-notified';
  end if;

  -- 3. Full recovery: the grouped signal recovers once. Both per-target
  --    openings in this test were silent (tracked during the grouped
  --    outage), so neither per-target recovery is announced; the
  --    grouped recovery is the announcement.
  update public.cloud_monitor_targets
     set status = 'operational', reason_code = 'ok',
         received_at = clock_timestamp()
   where id in ('aws-app', 'oci-mc');
  perform public.reconcile_cloud_monitor_signals_v1();
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'cloud:ingest-outage' and active) then
    raise exception 'grouped outage did not recover';
  end if;
  if not exists (select 1 from public.notification_outbox
                 where signal_key = 'cloud:ingest-outage' and transition = 'recovered') then
    raise exception 'grouped recovery missing';
  end if;
  if exists (select 1 from public.notification_outbox
             where signal_key = 'cloud:state:oci-mc' and transition = 'recovered'
               and occurred_at >= (select recovered_at from public.notification_signal_state
                                   where signal_key = 'cloud:ingest-outage')) then
    raise exception 'never-announced signal emitted a recovery';
  end if;

  -- 4. With a fresh probe reporting DEPLOYMENT_DISABLED, a new outage is
  --    labelled as a detected free-tier pause.
  perform public.record_console_ingest_health_v1(402, true, 'console.ivrm.jp/api/agent/heartbeat');
  update public.cloud_monitor_targets
     set received_at = clock_timestamp() - interval '901 seconds'
   where id in ('aws-app', 'oci-mc');
  perform public.reconcile_cloud_monitor_signals_v1();
  if (select message from public.notification_outbox
       where signal_key = 'cloud:ingest-outage' and transition = 'opened'
       order by id desc limit 1) not like '%DEPLOYMENT_DISABLED%' then
    raise exception 'probe-disabled outage was not labelled';
  end if;

  -- 5. Partial recovery: the grouped signal recovers, and the target
  --    that is still stale announces its own opened notification
  --    (catch-up), exactly once.
  update public.cloud_monitor_targets
     set received_at = clock_timestamp()
   where id = 'aws-app';
  select count(*) into v_outbox_before from public.notification_outbox
   where signal_key = 'cloud:state:oci-mc' and transition = 'opened';
  perform public.reconcile_cloud_monitor_signals_v1();
  if exists (select 1 from public.notification_signal_state
             where signal_key = 'cloud:ingest-outage' and active) then
    raise exception 'grouped outage did not recover on partial recovery';
  end if;
  if (select count(*) from public.notification_outbox
       where signal_key = 'cloud:state:oci-mc' and transition = 'opened' and status = 'pending')
     <> v_outbox_before + 1 then
    raise exception 'still-stale target did not announce after grouping ended';
  end if;
  perform public.reconcile_cloud_monitor_signals_v1();
  if (select count(*) from public.notification_outbox
       where signal_key = 'cloud:state:oci-mc' and transition = 'opened' and status = 'pending')
     <> v_outbox_before + 1 then
    raise exception 'catch-up opened notification duplicated';
  end if;

  -- 6. A stale probe (older than 10 minutes) must not label the cause.
  update public.cloud_monitor_targets
     set status = 'operational', reason_code = 'ok',
         received_at = clock_timestamp()
   where id = 'oci-mc';
  perform public.reconcile_cloud_monitor_signals_v1();
  update public.console_ingest_health
     set checked_at = clock_timestamp() - interval '11 minutes';
  update public.cloud_monitor_targets
     set received_at = clock_timestamp() - interval '901 seconds'
   where id in ('aws-app', 'oci-mc');
  perform public.reconcile_cloud_monitor_signals_v1();
  if (select message from public.notification_outbox
       where signal_key = 'cloud:ingest-outage' and transition = 'opened'
       order by id desc limit 1) like '%DEPLOYMENT_DISABLED%' then
    raise exception 'stale probe labelled the outage cause';
  end if;

  -- Leave the database healthy for any following tests.
  update public.cloud_monitor_targets
     set status = 'operational', reason_code = 'ok',
         received_at = clock_timestamp()
   where id in ('aws-app', 'oci-mc');
  perform public.reconcile_cloud_monitor_signals_v1();
end; $$;
select 'cloud ingest outage grouping contracts passed' as result;
