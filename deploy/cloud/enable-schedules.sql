-- Requires explicit production/cost approval. Migration alone never enables these jobs.
-- Reapplying replaces only the named jobs.
do $$ declare job bigint; begin
  for job in select jobid from cron.job where jobname in ('ivrm-cloud-monitor-reconcile-v1','ivrm-cloud-monitor-retention-v1') loop
    perform cron.unschedule(job);
  end loop;
end; $$;
select cron.schedule('ivrm-cloud-monitor-reconcile-v1','* * * * *',
  'select public.reconcile_cloud_monitor_signals_v1();');
select cron.schedule('ivrm-cloud-monitor-retention-v1','17 3 * * *',
  'select public.prune_cloud_monitor_history_v1();');
