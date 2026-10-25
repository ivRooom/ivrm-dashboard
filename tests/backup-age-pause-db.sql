begin;
insert into public.hosts(id,server_id) values ('00000000-0000-4000-8000-000000000001','test-host');
insert into public.backup_policies(host_id,backup_target,game_mode,backup_type)
values ('00000000-0000-4000-8000-000000000001','test','main','full'),
       ('00000000-0000-4000-8000-000000000001','test','other','full');

do $$
declare
  h uuid := '00000000-0000-4000-8000-000000000001';
  claim uuid := '00000000-0000-4000-8000-000000000002';
  entity text := h::text || ':test:main:full';
  key text := 'backup:' || entity || ':backup_age';
  row_id bigint;
  sent_id bigint;
  before_v1 jsonb;
  meta jsonb;
  failed boolean;
begin
  select to_jsonb(c) into before_v1 from public.get_backup_center_v1() c where c.game_mode='main';
  if exists(select 1 from public.backup_policies where age_paused_until is not null) then
    raise exception 'migration paused a policy';
  end if;
  -- Guard pairs, blank reason, past and unbounded windows.
  foreach failed in array array[true] loop
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()+interval '31 days',age_pause_reason='review';
      raise exception '31 day pause accepted';
    exception when invalid_parameter_value then null; end;
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()-interval '1 second',age_pause_reason='review';
      raise exception 'past pause accepted';
    exception when invalid_parameter_value then null; end;
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day',age_pause_reason=' ';
      raise exception 'blank reason accepted';
    exception when check_violation then null; end;
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day',age_pause_reason=repeat(' ',256)||'review';
      raise exception 'padded oversized reason accepted';
    exception when check_violation then null; end;
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day',age_pause_reason=E'\t';
      raise exception 'tab reason accepted';
    exception when check_violation then null; end;
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day',age_pause_reason=U&'\00A0\3000';
      raise exception 'Unicode whitespace reason accepted';
    exception when check_violation then null; end;
    begin
      update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day';
      raise exception 'unpaired metadata accepted';
    exception when check_violation then null; end;
  end loop;
  update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day',age_pause_reason=repeat('🛠️',80)
  where game_mode='main';
  update public.backup_policies set age_pause_reason='Issue #138: review'
  where game_mode='main';
  if public.notification_suppression_reason_v1(h,'backup',entity,'test',key,clock_timestamp()-interval '20 days') is distinct from 'backup_age_paused' then
    raise exception 'historical event bypassed current pause';
  end if;
  if public.notification_suppression_reason_v1(h,'backup',entity,'test','backup:'||entity||':retention',clock_timestamp()) is not null
    or public.notification_suppression_reason_v1(h,'backup',h::text||':test:other:full','test','backup:'||h::text||':test:other:full:backup_age',clock_timestamp()) is not null
    or public.notification_suppression_reason_v1(h,'backup',entity,'test',key||':spoof',clock_timestamp()) is not null
    or public.notification_suppression_reason_v1(h,'container',entity,'test',key,clock_timestamp()) is not null then
    raise exception 'pause escaped exact policy/signal scope';
  end if;
  select item into meta from jsonb_array_elements(public.get_backup_center_v2()) item where item->>'game_mode'='main';
  if meta->>'age_pause_reason' <> 'Issue #138: review' or meta->>'age_paused_until' is null then
    raise exception 'v2 omitted metadata';
  end if;
  if (select to_jsonb(c) from public.get_backup_center_v1() c where c.game_mode='main') is distinct from before_v1 then
    raise exception 'v1 compatibility broken';
  end if;
  if has_function_privilege('anon','public.get_backup_center_v2()','execute')
    or has_function_privilege('authenticated','public.get_backup_center_v2()','execute')
    or not has_function_privilege('service_role','public.get_backup_center_v2()','execute')
    or has_table_privilege('service_role','public.backup_policies','update') then
    raise exception 'RPC/table ACL widened';
  end if;
  insert into public.notification_signal_state(signal_key,source_type,host_id,server_id,entity_type,entity_key,entity_name,signal_type,severity,active,opened_at,last_seen_at,reason,detail_href)
  values(key,'backup',h,'test-host','backup',entity,'test','backup_age','critical',true,clock_timestamp()-interval '2 days',clock_timestamp(),'age expired','/backups');
  insert into public.notification_outbox(dedupe_key,signal_key,source_type,host_id,server_id,entity_type,entity_key,entity_name,transition,severity,title,message,detail_href,occurred_at)
  values('pending-age',key,'backup',h,'test-host','backup',entity,'test','opened','critical','Test','age expired','/backups',clock_timestamp()) returning id into row_id;
  perform * from public.claim_notification_outbox_v1(claim,10);
  if (select status from public.notification_outbox where id=row_id)<>'suppressed'
    or (select suppression_reason from public.notification_outbox where id=row_id)<>'backup_age_paused' then
    raise exception 'queued age was claimed';
  end if;
  -- A claim that predates the pause is blocked again immediately before send.
  update public.notification_outbox set status='sending',claim_token=claim,claimed_at=clock_timestamp() where id=row_id;
  if public.notification_delivery_block_reason_v1(row_id,claim) is distinct from 'backup_age_paused' then
    raise exception 'claimed row bypassed pause';
  end if;
  update public.notification_outbox set status='suppressed',claim_token=null,claimed_at=null where id=row_id;
  -- Expire naturally: no test-only disabling of trigger and no production clock mutation.
  update public.backup_policies set age_paused_until=clock_timestamp()+interval '0.1 seconds' where game_mode='main';
  perform pg_sleep(0.2);
  update public.backup_policies set warning_after_seconds=warning_after_seconds where game_mode='main';
  if public.notification_suppression_reason_v1(h,'backup',entity,'test',key,clock_timestamp()) is not null then
    raise exception 'expired pause still suppresses';
  end if;
  perform * from public.claim_notification_outbox_v1(claim,10);
  if (select status from public.notification_outbox where id=row_id)<>'sending' then
    raise exception 'unsent current episode did not resume';
  end if;
  update public.notification_outbox set status='sent',sent_at=clock_timestamp(),claim_token=null,claimed_at=null where id=row_id;
  sent_id := row_id;
  update public.backup_policies set age_paused_until=clock_timestamp()+interval '1 day' where game_mode='main';
  update public.backup_policies set age_paused_until=null,age_pause_reason=null where game_mode='main';
  perform * from public.claim_notification_outbox_v1(claim,10);
  if (select status from public.notification_outbox where id=sent_id)<>'sent'
    or (select count(*) from public.notification_outbox)<>1
    or not (select active from public.notification_signal_state where signal_key=key) then
    raise exception 'sent history changed or false recovery/repeat generated';
  end if;
end;
$$;
rollback;
\echo 'Backup age pause DB assertions passed'
