\set ON_ERROR_STOP on
insert into public.hosts(server_id) values('collector-a'),('collector-b');
insert into public.cloud_monitor_targets(id,provider,display_name,collector_server_id,enabled)
values('aws-app','aws','AWS App','collector-a',true),('oci-mc','oci','OCI MC','collector-b',true);
do $$
declare result text; count_before bigint; sample_time timestamptz;
begin
  if has_table_privilege('anon','public.cloud_monitor_targets','SELECT') or
    has_function_privilege('authenticated','public.ingest_cloud_monitor_v1(text,text,text,timestamptz,jsonb)','EXECUTE') then
    raise exception 'public access was granted'; end if;
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('a',32),repeat('b',64),clock_timestamp(),
    '[{"id":"oci-mc","status":"operational","reasonCode":"ok"}]');
  if result<>'target_not_allowed' then raise exception 'collector scope bypass: %',result; end if;
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('a',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"operational","reasonCode":"auth_error"}]');
  if result<>'invalid_payload' then raise exception 'false health accepted'; end if;
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('a',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"outage","reasonCode":"unexpected_state","raw":"secret"}]');
  if result<>'invalid_payload' then raise exception 'extra data accepted'; end if;
  if exists(select 1 from public.cloud_monitor_requests) then raise exception 'invalid batch consumed nonce'; end if;
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('a',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"outage","reasonCode":"unexpected_state"}]');
  if result<>'accepted' then raise exception 'ingestion failed: %',result; end if;
  if (select count(*) from public.notification_outbox where source_type='cloud' and transition='opened')<>1
    then raise exception 'outage did not open exactly one notification'; end if;
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('a',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"operational","reasonCode":"ok"}]');
  if result<>'replayed_request' then raise exception 'replay accepted'; end if;
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('c',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"operational","reasonCode":"ok"}]');
  if result<>'rate_limited' then raise exception 'rate limit missing'; end if;
  update public.cloud_monitor_requests set received_at=received_at-interval '16 seconds';
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('c',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"outage","reasonCode":"unexpected_state"}]');
  if result<>'accepted' or (select count(*) from public.notification_outbox where source_type='cloud')<>1
    then raise exception 'unchanged observation duplicated notification'; end if;
  select observed_at into sample_time from public.cloud_monitor_targets where id='aws-app';
  update public.cloud_monitor_requests set received_at=received_at-interval '16 seconds';
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('d',32),repeat('b',64),sample_time-interval '1 second',
    '[{"id":"aws-app","status":"operational","reasonCode":"ok"}]');
  if (select status from public.cloud_monitor_targets where id='aws-app')<>'outage'
    then raise exception 'old result rolled state backwards'; end if;
  update public.cloud_monitor_requests set received_at=received_at-interval '16 seconds';
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('e',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"operational","reasonCode":"ok"}]');
  if result<>'accepted' then raise exception 'recovery failed'; end if;
  if exists(select 1 from public.notification_outbox where source_type='cloud' and transition='opened' and status<>'suppressed')
    then raise exception 'old outage still deliverable after recovery'; end if;
  if not exists(select 1 from public.notification_outbox where source_type='cloud' and transition='recovered')
    then raise exception 'recovery missing'; end if;
  update public.cloud_monitor_targets set received_at=clock_timestamp()-interval '901 seconds' where id='aws-app';
  perform public.reconcile_cloud_monitor_signals_v1();
  if not exists(select 1 from public.notification_signal_state where signal_key='cloud:state:aws-app' and active and severity='critical' and reason='collector_stale')
    then raise exception 'collector death not detected independently'; end if;
  update public.cloud_monitor_targets set enabled=false where id='aws-app';
  select count(*) into count_before from public.notification_outbox where transition='recovered';
  perform public.reconcile_cloud_monitor_signals_v1();
  if exists(select 1 from public.notification_signal_state where signal_key='cloud:state:aws-app' and active)
    or exists(select 1 from public.notification_outbox where signal_key='cloud:state:aws-app' and status in ('pending','sending','retry'))
    or (select count(*) from public.notification_outbox where transition='recovered')<>count_before then
    raise exception 'disabled target left active delivery or emitted false recovery'; end if;
  select count(*) into count_before from public.cloud_monitor_samples;
  update public.cloud_monitor_requests set received_at=received_at-interval '16 seconds';
  result:=public.ingest_cloud_monitor_v1('collector-a',repeat('f',32),repeat('b',64),clock_timestamp(),
    '[{"id":"aws-app","status":"outage","reasonCode":"unexpected_state"}]');
  if result<>'accepted' or (select count(*) from public.cloud_monitor_samples)<>count_before then
    raise exception 'disabled target should be ignored without poisoning the collector batch'; end if;
end; $$;
select 'cloud monitoring database contracts passed' as result;
