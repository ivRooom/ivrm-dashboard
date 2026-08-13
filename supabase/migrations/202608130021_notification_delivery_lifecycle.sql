-- Notification delivery lifecycle hardening.
-- Channelの停止/再開とDispatcher実行中の競合を安全側へ寄せる。

-- Host表示名はNotification Titleの上限内に収まる長さへ制約する。
-- Production既存値は事前確認済み（最大18文字）。
alter table public.hosts
  drop constraint if exists hosts_display_name_notification_safe_check;
alter table public.hosts
  add constraint hosts_display_name_notification_safe_check
  check (display_name is not null and char_length(display_name) between 1 and 120);

create or replace function public.notification_channel_ready_v1()
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select coalesce((
    select channels.enabled and channels.configured
    from public.notification_channels as channels
    where channels.id = 1
  ), false);
$$;

create or replace function public.suppress_notification_delivery_v1(
  p_id bigint,
  p_claim_token uuid,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_id is null or p_id < 1
    or p_claim_token is null
    or p_reason is null or char_length(p_reason) not between 1 and 256 then
    raise exception 'notification_suppress_delivery_invalid' using errcode = '22023';
  end if;

  update public.notification_outbox
  set status = 'suppressed',
      suppression_reason = p_reason,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where id = p_id
    and status = 'sending'
    and claim_token = p_claim_token;

  if not found then
    return 'claim_mismatch';
  end if;

  return 'suppressed';
end;
$$;

create or replace function public.set_notification_channel_v1(
  p_enabled boolean,
  p_configured boolean,
  p_display_name text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reason text;
begin
  if p_enabled is null or p_configured is null
    or (p_display_name is not null and char_length(p_display_name) not between 1 and 80) then
    raise exception 'notification_channel_invalid' using errcode = '22023';
  end if;

  update public.notification_channels
  set enabled = p_enabled,
      configured = p_configured,
      display_name = coalesce(p_display_name, display_name),
      updated_at = clock_timestamp()
  where id = 1;

  if not (p_enabled and p_configured) then
    v_reason := case when not p_enabled then 'channel_disabled' else 'channel_unconfigured' end;

    -- OFFへ切り替えた時点で未配送行を残さない。
    -- sendingもClaimを解除し、再有効化時の古い一括送信を防ぐ。
    update public.notification_outbox
    set status = 'suppressed',
        suppression_reason = v_reason,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where status in ('pending', 'retry', 'sending');
  end if;
end;
$$;

create or replace function public.claim_notification_outbox_v1(
  p_claim_token uuid,
  p_limit integer default 10
)
returns table (
  id bigint,
  source_type text,
  server_id text,
  entity_type text,
  entity_name text,
  transition text,
  severity text,
  title text,
  message text,
  detail_href text,
  occurred_at timestamptz,
  attempts integer
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_claim_token is null or p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'notification_claim_invalid' using errcode = '22023';
  end if;

  -- ChannelがOFF/未設定ならClaim自体を行わない。
  if not public.notification_channel_ready_v1() then
    return;
  end if;

  update public.notification_outbox
  set status = 'retry',
      claim_token = null,
      claimed_at = null,
      next_attempt_at = clock_timestamp(),
      last_error_code = 'claim_timeout',
      updated_at = clock_timestamp()
  where status = 'sending'
    and claimed_at < clock_timestamp() - interval '5 minutes';

  -- 抑制中に発生し、現在もActiveなSignalについて、
  -- 現在の抑制条件が解除されていれば「最新の発生/重大化」1件だけを再配送可能にする。
  -- OOM/Restartなどsignal_keyを持たないone-shotは古い通知として再送しない。
  with latest_suppressed as (
    select distinct on (outbox.signal_key)
      outbox.id,
      outbox.host_id,
      outbox.entity_type,
      outbox.entity_key,
      outbox.entity_name,
      outbox.signal_key
    from public.notification_outbox as outbox
    join public.notification_signal_state as signals
      on signals.signal_key = outbox.signal_key
     and signals.active
     and outbox.occurred_at >= signals.opened_at
    where outbox.status = 'suppressed'
      and outbox.signal_key is not null
      and outbox.transition in ('opened', 'escalated')
    order by outbox.signal_key, outbox.occurred_at desc, outbox.id desc
  ), releasable as (
    select latest.id
    from latest_suppressed as latest
    where public.notification_suppression_reason_v1(
      latest.host_id,
      latest.entity_type,
      latest.entity_key,
      latest.entity_name,
      latest.signal_key,
      clock_timestamp()
    ) is null
  )
  update public.notification_outbox as outbox
  set status = 'pending',
      suppression_reason = null,
      next_attempt_at = clock_timestamp(),
      last_error_code = null,
      updated_at = clock_timestamp()
  from releasable
  where outbox.id = releasable.id;

  return query
  with picked as (
    select outbox.id
    from public.notification_outbox as outbox
    where outbox.status in ('pending', 'retry')
      and outbox.next_attempt_at <= clock_timestamp()
    order by
      case outbox.severity when 'critical' then 1 when 'warning' then 2 when 'recovery' then 3 else 4 end,
      outbox.occurred_at,
      outbox.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.notification_outbox as outbox
    set status = 'sending',
        attempts = outbox.attempts + 1,
        claim_token = p_claim_token,
        claimed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    from picked
    where outbox.id = picked.id
    returning outbox.*
  )
  select
    claimed.id,
    claimed.source_type,
    claimed.server_id,
    claimed.entity_type,
    claimed.entity_name,
    claimed.transition,
    claimed.severity,
    claimed.title,
    claimed.message,
    claimed.detail_href,
    claimed.occurred_at,
    claimed.attempts
  from claimed
  order by claimed.occurred_at, claimed.id;
end;
$$;

revoke all on function public.notification_channel_ready_v1()
  from public, anon, authenticated;
grant execute on function public.notification_channel_ready_v1()
  to service_role;

revoke all on function public.suppress_notification_delivery_v1(bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.suppress_notification_delivery_v1(bigint, uuid, text)
  to service_role;

revoke all on function public.set_notification_channel_v1(boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_notification_channel_v1(boolean, boolean, text)
  to service_role;

revoke all on function public.claim_notification_outbox_v1(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_outbox_v1(uuid, integer)
  to service_role;

comment on function public.notification_channel_ready_v1() is
  'Discord Notification Channelがenabled/configuredの両方を満たす場合のみtrueを返す。';
comment on function public.suppress_notification_delivery_v1(bigint, uuid, text) is
  'DispatcherがClaim済みRowを送信せずSuppressedへ戻すためのService Role専用RPC。';
comment on function public.claim_notification_outbox_v1(uuid, integer) is
  'Channel Ready時だけOutboxをClaimし、抑制解除後も継続中のActive Signalは最新Suppressed Transitionだけを再配送可能にする。';
