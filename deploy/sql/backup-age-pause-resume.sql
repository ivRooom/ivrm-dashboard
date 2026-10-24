-- Compare-and-clear only the exact approved pause. Uses the original vars.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
select set_config('ivrm.pause_until', :'pause_until', true),
       set_config('ivrm.pause_reason', :'pause_reason', true);
do $$
declare affected integer;
begin
  update public.backup_policies p
  set age_paused_until=null,age_pause_reason=null,updated_at=clock_timestamp()
  from public.hosts h
  where h.id=p.host_id and h.server_id='oci-minecraft-01' and p.backup_type='full'
    and (p.backup_target,p.game_mode) in (
      ('minecraft-paper','paper'),('minecraft-skyblock','skyblock'),
      ('minecraft-hardcore','hardcore'),('minecraft-gtnh','gtnh'),('minecraft-atm10','atm10'))
    and p.age_paused_until=current_setting('ivrm.pause_until')::timestamptz
    and p.age_pause_reason=current_setting('ivrm.pause_reason');
  get diagnostics affected=row_count;
  if affected<>5 then raise exception 'pause_changed_or_target_mismatch_no_resume_applied'; end if;
end;
$$;
commit;
