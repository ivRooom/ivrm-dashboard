-- Additive migration: does not pause any policy, disable collection or change retention.
alter table public.backup_policies
  add column age_paused_until timestamptz,
  add column age_pause_reason text,
  add constraint backup_age_pause_pair check (
    (age_paused_until is null and age_pause_reason is null) or
    (age_paused_until is not null and age_pause_reason is not null
      and char_length(age_pause_reason) between 1 and 256
      -- Match ECMAScript trim whitespace; char_length counts Unicode code points.
      and char_length(btrim(age_pause_reason,
        U&' \0009\000A\000B\000C\000D\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0)
  );

create or replace function public.validate_backup_age_pause_v1()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if (tg_op = 'INSERT' or new.age_paused_until is distinct from old.age_paused_until
      or new.age_pause_reason is distinct from old.age_pause_reason)
    and new.age_paused_until is not null then
    if new.age_paused_until <= clock_timestamp()
      or new.age_paused_until > clock_timestamp() + interval '30 days' then
      raise exception 'backup_age_pause_window_invalid' using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger validate_backup_age_pause_trigger
before insert or update on public.backup_policies
for each row execute function public.validate_backup_age_pause_v1();
revoke all on function public.validate_backup_age_pause_v1() from public, anon, authenticated, service_role;

-- Keep v1 stable for existing consumers; v2 adds metadata in one DB snapshot.
create or replace function public.get_backup_center_v2()
returns jsonb language sql security definer set search_path = pg_catalog, public stable as $$
  select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object(
    'age_paused_until', p.age_paused_until, 'age_pause_reason', p.age_pause_reason
  ) order by c.host_display_name, c.backup_target, c.game_mode, c.backup_type), '[]'::jsonb)
  from public.get_backup_center_v1() c
  join public.backup_policies p on p.id = c.policy_id;
$$;
revoke all on function public.get_backup_center_v2() from public, anon, authenticated;
grant execute on function public.get_backup_center_v2() to service_role;

create or replace function public.notification_suppression_reason_v1(
  p_host_id uuid,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_signal_key text,
  p_occurred_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_reason text;
  v_channel public.notification_channels%rowtype;
begin
  select * into v_channel
  from public.notification_channels
  where id = 1;

  if not found or not v_channel.enabled then
    return 'channel_disabled';
  end if;

  if not v_channel.configured then
    return 'channel_unconfigured';
  end if;

  -- Only the exact policy Age signal is muted; integrity/retention/run alerts remain.
  -- Use dispatch time, never the historical event timestamp.
  if p_entity_type = 'backup' and exists (
    select 1 from public.backup_policies p
    where p.enabled and p.host_id = p_host_id
      and p_entity_key = p.host_id::text || ':' || p.backup_target || ':' || p.game_mode || ':' || p.backup_type
      and p_signal_key = 'backup:' || p_entity_key || ':backup_age'
      and p.age_paused_until > clock_timestamp()
  ) then
    return 'backup_age_paused';
  end if;

  if p_entity_type = 'container' and exists (
    select 1
    from public.container_expectations as expectations
    where expectations.host_id = p_host_id
      and expectations.container_name = p_entity_name
      and expectations.maintenance_mode
      and (
        expectations.maintenance_until is null
        or expectations.maintenance_until > clock_timestamp()
      )
  ) then
    return 'container_maintenance';
  end if;

  select suppressions.reason
  into v_reason
  from public.notification_suppressions as suppressions
  where suppressions.enabled
    and suppressions.starts_at <= p_occurred_at
    and (suppressions.ends_at is null or suppressions.ends_at > p_occurred_at)
    and (
      (suppressions.scope_type = 'global' and suppressions.scope_key = '*')
      or (suppressions.scope_type = 'host' and suppressions.scope_key = p_host_id::text)
      or (suppressions.scope_type = p_entity_type and suppressions.scope_key = p_entity_key)
      or (suppressions.scope_type = 'signal' and suppressions.scope_key = p_signal_key)
    )
  order by
    case suppressions.scope_type
      when 'signal' then 1
      when 'container' then 2
      when 'backup' then 2
      when 'host' then 3
      else 4
    end,
    suppressions.starts_at desc,
    suppressions.id desc
  limit 1;

  return v_reason;
end;
$$;

revoke all on function public.notification_suppression_reason_v1(uuid,text,text,text,text,timestamptz)
  from public, anon, authenticated, service_role;
comment on function public.get_backup_center_v2() is
  'Backup Center v1 + bounded Age-only pause metadata. Service role read-only; does not imply restore readiness.';
