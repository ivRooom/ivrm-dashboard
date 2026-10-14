-- Disables only new cloud jobs; existing notification and host schedules are untouched.
do $$ declare job bigint; begin
  for job in select jobid from cron.job where jobname in ('ivrm-cloud-monitor-reconcile-v1','ivrm-cloud-monitor-retention-v1') loop
    perform cron.unschedule(job);
  end loop;
end; $$;
update public.cloud_monitor_targets set enabled=false;
select public.reconcile_cloud_monitor_signals_v1();
