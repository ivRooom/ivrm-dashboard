-- Issue #232: weekly inventory of long-active signals.
--
-- run_signal_inventory_v1 is called from the minutely job. It evaluates at
-- most once per week (Monday 09:00 JST window, Asia/Tokyo) and sends one
-- digest notification listing every signal that has been active for 7+
-- days, so long-forgotten alerts (e.g. the http-home outage that stayed
-- active for ~20 days, Issue #219) resurface weekly instead of rotting.
-- The board-visible signal state is tracked silently through
-- apply_cloud_monitor_signal_v2 (notify=false); the digest itself is
-- enqueued directly with a per-week dedupe key.

create table if not exists public.signal_inventory_runs (
  week_start timestamptz primary key,
  stale_count integer not null,
  ran_at timestamptz not null default clock_timestamp()
);

create or replace function public.run_signal_inventory_v1(
  p_now timestamptz default clock_timestamp()
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp;
  v_week_start timestamptz;
  v_count integer := 0;
  v_shown integer := 0;
  v_lines text := '';
  v_state public.notification_signal_state%rowtype;
  v_was_active boolean := false;
  s record;
begin
  v_local := p_now at time zone 'Asia/Tokyo';

  -- Weekly window: Monday 09:00-09:59 JST. Outside it, do nothing.
  if extract(isodow from v_local) <> 1 or extract(hour from v_local) <> 9 then
    return -1;
  end if;

  v_week_start := (date_trunc('week', v_local) at time zone 'Asia/Tokyo');

  -- One evaluation per week.
  if exists (select 1 from public.signal_inventory_runs where week_start = v_week_start) then
    return -2;
  end if;

  for s in
    select entity_name, severity, opened_at
    from public.notification_signal_state
    where active
      and opened_at <= p_now - interval '7 days'
      and signal_key <> 'cloud:signal-inventory:weekly'
    order by opened_at
  loop
    v_count := v_count + 1;
    if v_shown < 10 then
      v_lines := v_lines || E'\n' || '・' || s.entity_name || '（' || s.severity || '、'
        || floor(extract(epoch from (p_now - s.opened_at)) / 86400)::integer || '日経過）';
      v_shown := v_shown + 1;
    end if;
  end loop;

  select * into v_state from public.notification_signal_state
    where signal_key = 'cloud:signal-inventory:weekly';
  v_was_active := v_state.signal_key is not null and v_state.active;

  if v_count > 0 then
    if v_count > v_shown then
      v_lines := v_lines || E'\n' || '・ほか ' || (v_count - v_shown) || ' 件';
    end if;
    -- Silent board state, then the week's single digest.
    perform public.apply_cloud_monitor_signal_v2(
      'cloud:signal-inventory:weekly', 'cloud', null, 'ivrm', 'cloud', 'signal-inventory',
      '長期未解消シグナル棚卸し', 'signal_inventory',
      true, 'warning', p_now,
      'signal_inventory: 7日以上 active な Signal が ' || v_count || ' 件あります。',
      '棚卸し: 長期未解消シグナル', '/cloud', false);
    perform public.enqueue_cloud_notification_v1(
      'signal-inventory:opened:' || to_char(v_week_start, 'YYYY-MM-DD'),
      'cloud:signal-inventory:weekly', 'cloud', null, 'ivrm', 'cloud', 'signal-inventory',
      '長期未解消シグナル棚卸し', 'opened', 'warning',
      '棚卸し: 長期未解消シグナル',
      '7日以上 active な Signal が ' || v_count || ' 件あります。' || v_lines,
      '/cloud', p_now);
    insert into public.signal_inventory_runs (week_start, stale_count)
    values (v_week_start, v_count);
  elsif v_was_active then
    perform public.apply_cloud_monitor_signal_v2(
      'cloud:signal-inventory:weekly', 'cloud', null, 'ivrm', 'cloud', 'signal-inventory',
      '長期未解消シグナル棚卸し', 'signal_inventory',
      false, 'warning', p_now,
      'signal_inventory: 7日以上 active な Signal はありません。',
      '棚卸し: 長期未解消シグナル', '/cloud', false);
    perform public.enqueue_cloud_notification_v1(
      'signal-inventory:recovered:' || to_char(v_week_start, 'YYYY-MM-DD'),
      'cloud:signal-inventory:weekly', 'cloud', null, 'ivrm', 'cloud', 'signal-inventory',
      '長期未解消シグナル棚卸し', 'recovered', 'warning',
      '棚卸し: 長期未解消シグナル',
      '7日以上 active な Signal はなくなりました。',
      '/cloud', p_now);
    insert into public.signal_inventory_runs (week_start, stale_count)
    values (v_week_start, 0);
  end if;

  return v_count;
end;
$$;

revoke all on function public.run_signal_inventory_v1(timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.run_signal_inventory_v1(timestamptz) to service_role;
  end if;
end;
$$;
