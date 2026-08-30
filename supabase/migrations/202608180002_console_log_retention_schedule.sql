do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = 'ivrm-console-log-retention-v1'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'ivrm-console-log-retention-v1',
    '11 * * * *',
    'select public.prune_console_log_rows_v1(5000);'
  );
end;
$$;

comment on function public.prune_console_log_rows_v1(integer) is
  'Console Logの24時間Retention。Log ingest時に加え、pg_cronから毎時bounded deleteする内部Job。';
