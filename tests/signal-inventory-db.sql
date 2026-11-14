-- Issue #232 contracts: weekly inventory of signals active for 7+ days.
-- Mondays used below: 2026-11-16 and 2026-11-23 (Asia/Tokyo).

update public.notification_channels
set enabled = true, configured = true
where id = 1;
insert into public.hosts (id, server_id, display_name, enabled)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'inventory-host', 'Inventory Host', true)
on conflict (id) do nothing;

-- One stale signal (10 days old at evaluation), one fresh (2 days), one
-- already recovered (must not be listed).
insert into public.notification_signal_state (
  signal_key, source_type, host_id, server_id, entity_type, entity_key,
  entity_name, signal_type, severity, active, opened_at, last_seen_at,
  recovered_at, reason, detail_href
) values
  ('host:heartbeat:inventory-host', 'host', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'inventory-host', 'host', 'inventory-host', 'Inventory Host', 'heartbeat', 'critical', true,
   '2026-11-16 09:30:00+09'::timestamptz - interval '10 days', '2026-11-16 09:30:00+09'::timestamptz, null, 'seed stale', '/hosts'),
  ('cloud:state:fresh-target', 'cloud', null, 'ivrm', 'cloud', 'fresh-target', 'Fresh Target', 'cloud_state', 'warning', true,
   '2026-11-16 09:30:00+09'::timestamptz - interval '2 days', '2026-11-16 09:30:00+09'::timestamptz, null, 'seed fresh', '/cloud'),
  ('cloud:state:gone-target', 'cloud', null, 'ivrm', 'cloud', 'gone-target', 'Gone Target', 'cloud_state', 'warning', false,
   '2026-11-16 09:30:00+09'::timestamptz - interval '20 days', '2026-11-16 09:30:00+09'::timestamptz - interval '1 day', '2026-11-16 09:30:00+09'::timestamptz - interval '1 day', 'seed gone', '/cloud')
on conflict (signal_key) do nothing;

-- Outside the window (Tuesday) nothing happens.
do $$
declare
  v_result integer;
begin
  v_result := public.run_signal_inventory_v1('2026-11-17 09:30:00+09'::timestamptz);
  if v_result <> -1 then
    raise exception 'inventory must skip outside the Monday 09:00 JST window, got %', v_result;
  end if;
  if exists (select 1 from public.notification_outbox where signal_key = 'cloud:signal-inventory:weekly') then
    raise exception 'inventory emitted outside its window';
  end if;
end;
$$;

-- In the window: exactly one opened digest naming only the stale signal.
do $$
declare
  v_result integer;
  v_opened integer;
begin
  v_result := public.run_signal_inventory_v1('2026-11-16 09:30:00+09'::timestamptz);
  if v_result <> 1 then
    raise exception 'inventory must count exactly the one stale signal, got %', v_result;
  end if;
  select count(*) into v_opened from public.notification_outbox
  where signal_key = 'cloud:signal-inventory:weekly' and transition = 'opened' and status = 'pending';
  if v_opened <> 1 then
    raise exception 'inventory opened notifications: expected 1, got %', v_opened;
  end if;
  if not exists (
    select 1 from public.notification_outbox
    where signal_key = 'cloud:signal-inventory:weekly' and transition = 'opened'
      and message like '%Inventory Host%' and message like '%10日経過%'
      and message not like '%Fresh Target%' and message not like '%Gone Target%'
  ) then
    raise exception 'inventory digest content mismatch';
  end if;
end;
$$;

-- Same window again: the weekly dedupe keeps it to one digest.
do $$
declare
  v_result integer;
begin
  v_result := public.run_signal_inventory_v1('2026-11-16 09:45:00+09'::timestamptz);
  if v_result <> -2 then
    raise exception 'inventory must skip when already announced this week, got %', v_result;
  end if;
  if (select count(*) from public.notification_outbox where signal_key = 'cloud:signal-inventory:weekly' and transition = 'opened') <> 1 then
    raise exception 'inventory opened a duplicate digest in the same week';
  end if;
end;
$$;

-- Next week nothing is stale (this suite shares one database with the
-- suites above, so recover every other active signal too): the
-- inventory signal recovers.
update public.notification_signal_state
set active = false, recovered_at = '2026-11-20 00:00:00+09'::timestamptz
where active and signal_key <> 'cloud:signal-inventory:weekly';

do $$
declare
  v_result integer;
begin
  v_result := public.run_signal_inventory_v1('2026-11-23 09:30:00+09'::timestamptz);
  if v_result <> 0 then
    raise exception 'inventory must report zero stale signals, got %', v_result;
  end if;
  if exists (select 1 from public.notification_signal_state where signal_key = 'cloud:signal-inventory:weekly' and active) then
    raise exception 'inventory signal must recover when nothing is stale';
  end if;
  if not exists (
    select 1 from public.notification_outbox
    where signal_key = 'cloud:signal-inventory:weekly' and transition = 'recovered'
  ) then
    raise exception 'inventory recovery was not enqueued';
  end if;
end;
$$;

select 'signal inventory contracts passed' as result;
