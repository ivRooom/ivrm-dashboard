-- Reliability Burn RateのCritical -> Warning降格で抑制した古いCriticalを、
-- 通常の一時Suppression解除ロジックが再配送対象へ戻さないようにする。

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

  -- Pending/Retry中に新しいMaintenance・明示Suppressionが開始された場合も再評価する。
  with blocked as (
    select
      outbox.id,
      public.notification_suppression_reason_v1(
        outbox.host_id,
        outbox.entity_type,
        outbox.entity_key,
        outbox.entity_name,
        coalesce(outbox.signal_key, outbox.dedupe_key),
        clock_timestamp()
      ) as reason
    from public.notification_outbox as outbox
    where outbox.status in ('pending', 'retry')
  )
  update public.notification_outbox as outbox
  set status = 'suppressed',
      suppression_reason = blocked.reason,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  from blocked
  where outbox.id = blocked.id
    and blocked.reason is not null;

  -- Recovery済み/新Episodeへ置換済みのOpen/Escalationは配送しない。
  update public.notification_outbox as outbox
  set status = 'suppressed',
      suppression_reason = 'signal_recovered_before_delivery',
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where outbox.status in ('pending', 'retry')
    and outbox.signal_key is not null
    and outbox.transition in ('opened', 'escalated')
    and not exists (
      select 1
      from public.notification_signal_state as signals
      where signals.signal_key = outbox.signal_key
        and signals.active
        and outbox.occurred_at >= signals.opened_at
    );

  -- Opening/Escalationを1件も正常配送できなかったEpisodeのRecoveryは単独送信しない。
  update public.notification_outbox as outbox
  set status = 'suppressed',
      suppression_reason = case
        when exists (
          select 1
          from public.notification_signal_state as current_signal
          where current_signal.signal_key = outbox.signal_key
            and current_signal.active
            and outbox.occurred_at < current_signal.opened_at
        ) then 'superseded_by_new_incident'
        else 'recovered_before_first_delivery'
      end,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where outbox.status in ('pending', 'retry')
    and outbox.signal_key is not null
    and outbox.transition = 'recovered'
    and not exists (
      select 1
      from public.notification_outbox as delivered
      left join public.notification_signal_state as signals
        on signals.signal_key = outbox.signal_key
      where delivered.signal_key = outbox.signal_key
        and delivered.transition in ('opened', 'escalated')
        and delivered.status = 'sent'
        and delivered.occurred_at <= outbox.occurred_at
        and (
          signals.signal_key is null
          or delivered.occurred_at >= signals.opened_at
          or outbox.occurred_at < signals.opened_at
        )
    );

  -- 抑制中に発生し、現在もActiveなSignalについて、現在の抑制条件が解除済みなら
  -- 現Episodeの最新opened/escalated 1件だけ再配送可能にする。
  -- Signalの状態変化自体を理由に恒久Suppressedへ落とした行は再解放しない。
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
      and outbox.suppression_reason not in (
        'signal_recovered_before_delivery',
        'signal_deescalated_before_delivery',
        'backup_policy_disabled',
        'superseded_by_new_incident'
      )
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
      and (
        outbox.signal_key is null
        or not exists (
          select 1
          from public.notification_outbox as earlier
          where earlier.signal_key = outbox.signal_key
            and earlier.id <> outbox.id
            and earlier.status in ('pending', 'retry', 'sending')
            and (
              earlier.occurred_at < outbox.occurred_at
              or (earlier.occurred_at = outbox.occurred_at and earlier.id < outbox.id)
            )
        )
      )
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

revoke all on function public.claim_notification_outbox_v1(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_outbox_v1(uuid, integer)
  to service_role;

comment on function public.claim_notification_outbox_v1(uuid, integer) is
  'Claims Notification Outbox rows with ordering and dynamic suppression. signal_deescalated_before_delivery is a permanent suppression reason and is never re-released.';
