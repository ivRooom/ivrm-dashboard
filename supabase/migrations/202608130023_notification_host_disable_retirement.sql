-- Monitoring対象から外したHostのNotification lifecycleを退役する。

create or replace function public.notification_host_disable_retire_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not (old.enabled and not new.enabled) then
    return new;
  end if;

  -- 未配送のHost / Container / Backup通知を停止し、再有効化時の古い後送信を防ぐ。
  update public.notification_outbox
  set status = 'suppressed',
      suppression_reason = 'host_disabled',
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where host_id = old.id
    and status in ('pending', 'retry', 'sending', 'suppressed');

  -- Hostを監視対象外へした時点で現在Signalは退役する。
  -- 再有効化後は最新Heartbeat / Container / Backup状態から新Episodeとして再生成する。
  delete from public.notification_signal_state
  where host_id = old.id;

  return new;
end;
$$;

drop trigger if exists notification_host_disable_retire_trigger
  on public.hosts;
create trigger notification_host_disable_retire_trigger
before update of enabled on public.hosts
for each row
execute function public.notification_host_disable_retire_v1();

revoke all on function public.notification_host_disable_retire_v1()
  from public, anon, authenticated, service_role;

comment on function public.notification_host_disable_retire_v1() is
  'hosts.enabledをtrueからfalseへ変更した際、当該Host配下の現在Notification Signalを退役し、未配送Outboxをhost_disabledとしてSuppressedへ移す。';
