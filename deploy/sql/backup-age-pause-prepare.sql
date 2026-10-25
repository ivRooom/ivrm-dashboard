-- Operator-only, production change approval required. No retention/backup changes.
-- Required psql vars: pause_until (ISO timestamp), pause_reason (change reference).
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
set local statement_timeout='15s';
select set_config('ivrm.pause_until', :'pause_until', true),
       set_config('ivrm.pause_reason', :'pause_reason', true);
create temporary table selected_backup_pause_policy on commit drop as
select p.id,p.host_id,p.backup_target,p.game_mode,p.backup_type
from public.backup_policies p
join public.hosts h on h.id=p.host_id
where h.server_id='oci-minecraft-01' and h.enabled and p.enabled and p.backup_type='full'
  and (p.backup_target,p.game_mode) in (
    ('minecraft-paper','paper'),('minecraft-skyblock','skyblock'),
    ('minecraft-hardcore','hardcore'),('minecraft-gtnh','gtnh'),('minecraft-atm10','atm10')
  );
select p.id,p.backup_target,p.game_mode,p.enabled,p.age_paused_until,p.age_pause_reason as previous_reason
from public.backup_policies p join selected_backup_pause_policy s on s.id=p.id
order by p.id for update of p;
do $$
declare affected integer;
begin
  if (select count(*) from selected_backup_pause_policy)<>5 then
    raise exception 'expected_exactly_five_enabled_backup_policies';
  end if;
  update public.backup_policies p
  set age_paused_until=current_setting('ivrm.pause_until')::timestamptz,
      age_pause_reason=current_setting('ivrm.pause_reason'),updated_at=clock_timestamp()
  from selected_backup_pause_policy s
  where p.id=s.id and p.host_id=s.host_id and p.backup_target=s.backup_target
    and p.game_mode=s.game_mode and p.backup_type=s.backup_type and p.enabled
    and p.age_paused_until is null and p.age_pause_reason is null
    and exists(select 1 from public.hosts h where h.id=p.host_id and h.enabled and h.server_id='oci-minecraft-01');
  get diagnostics affected=row_count;
  if affected<>5 then raise exception 'existing_pause_requires_explicit_review'; end if;
end;
$$;
select p.id,p.backup_target,p.game_mode,p.enabled,p.age_paused_until,p.age_pause_reason
from public.backup_policies p join selected_backup_pause_policy s on s.id=p.id order by p.id;
commit;
