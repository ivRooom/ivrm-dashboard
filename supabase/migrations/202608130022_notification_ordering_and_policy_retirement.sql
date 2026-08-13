-- Notification ordering / dynamic suppression / policy retirement hardening.

create or replace function public.apply_notification_signal_v1(
  p_signal_key text,
  p_source_type text,
  p_host_id uuid,
  p_server_id text,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_signal_type text,
  p_active boolean,
  p_severity text,
  p_occurred_at timestamptz,
  p_reason text,
  p_title text,
  p_detail_href text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current public.notification_signal_state%rowtype;
  v_transition text;
  v_dedupe_key text;
  v_delivery_severity text;
  v_title text;
begin
  if p_signal_key is null or char_length(p_signal_key) not between 1 and 500
    or p_source_type is null or p_source_type not in ('host', 'container', 'backup')
    or p_host_id is null
    or p_server_id is null or char_length(p_server_id) not between 1 and 128
    or p_entity_type is null or p_entity_type not in ('host', 'container', 'backup')
    or p_entity_key is null or char_length(p_entity_key) not between 1 and 400
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_signal_type is null or char_length(p_signal_type) not between 1 and 80
    or p_active is null
    or p_severity is null or p_severity not in ('warning', 'critical')
    or p_occurred_at is null
    or p_reason is null or char_length(p_reason) not between 1 and 1800
    or p_title is null or char_length(p_title) not between 1 and 140
    or p_detail_href is null
    or char_length(p_detail_href) > 1001
    or p_detail_href !~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$' then
    raise exception 'notification_signal_invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_signal_key, 0));

  select * into v_current
  from public.notification_signal_state
  where signal_key = p_signal_key
  for update;

  if found and p_occurred_at < v_current.last_seen_at then
    return 'stale_ignored';
  end if;

  if p_active then
    if not found then
      insert into public.notification_signal_state (
        signal_key, source_type, host_id, server_id, entity_type, entity_key,
        entity_name, signal_type, severity, active, opened_at, last_seen_at,
        recovered_at, reason, detail_href
      ) values (
        p_signal_key, p_source_type, p_host_id, p_server_id, p_entity_type, p_entity_key,
        p_entity_name, p_signal_type, p_severity, true, p_occurred_at, p_occurred_at,
        null, p_reason, p_detail_href
      );
      v_transition := 'opened';
    elsif not v_current.active then
      update public.notification_signal_state
      set source_type = p_source_type,
          host_id = p_host_id,
          server_id = p_server_id,
          entity_type = p_entity_type,
          entity_key = p_entity_key,
          entity_name = p_entity_name,
          signal_type = p_signal_type,
          severity = p_severity,
          active = true,
          opened_at = p_occurred_at,
          last_seen_at = p_occurred_at,
          recovered_at = null,
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;
      v_transition := 'opened';
    elsif public.notification_severity_rank_v1(p_severity) > public.notification_severity_rank_v1(v_current.severity) then
      update public.notification_signal_state
      set severity = p_severity,
          last_seen_at = p_occurred_at,
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;
      v_transition := 'escalated';
    else
      update public.notification_signal_state
      set last_seen_at = p_occurred_at,
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;
      return 'unchanged';
    end if;

    v_delivery_severity := p_severity;
    v_title := case when v_transition = 'escalated' then '重大化: ' || p_title else p_title end;
  else
    if not found or not v_current.active then
      return 'unchanged';
    end if;

    -- 復旧したSignalの未配送Open/Escalationを先に無効化する。
    -- Retry Backoff中の古いCriticalがRecovery後に配送されることを防ぐ。
    update public.notification_outbox
    set status = 'suppressed',
        suppression_reason = 'signal_recovered_before_delivery',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where signal_key = p_signal_key
      and transition in ('opened', 'escalated')
      and occurred_at >= v_current.opened_at
      and status in ('pending', 'retry', 'sending');

    update public.notification_signal_state
    set active = false,
        last_seen_at = p_occurred_at,
        recovered_at = greatest(opened_at, p_occurred_at),
        reason = p_reason,
        detail_href = p_detail_href,
        updated_at = clock_timestamp()
    where signal_key = p_signal_key;

    v_transition := 'recovered';
    v_delivery_severity := 'recovery';
    v_title := '復旧: ' || p_title;
  end if;

  v_dedupe_key := p_signal_key || ':' || v_transition || ':' || to_char(p_occurred_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');

  perform public.enqueue_notification_v1(
    v_dedupe_key,
    p_signal_key,
    p_source_type,
    p_host_id,
    p_server_id,
    p_entity_type,
    p_entity_key,
    p_entity_name,
    v_transition,
    v_delivery_severity,
    v_title,
    p_reason,
    p_detail_href,
    p_occurred_at
  );

  return v_transition;
end;
$$;

create or replace function public.notification_delivery_block_reason_v1(
  p_id bigint,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
declare
  v_row public.notification_outbox%rowtype;
  v_signal public.notification_signal_state%rowtype;
  v_reason text;
begin
  if p_id is null or p_id < 1 or p_claim_token is null then
    return 'claim_mismatch';
  end if;

  select * into v_row
  from public.notification_outbox
  where id = p_id
    and status = 'sending'
    and claim_token = p_claim_token;

  if not found then
    return 'claim_mismatch';
  end if;

  if not public.notification_channel_ready_v1() then
    return 'channel_disabled_during_dispatch';
  end if;

  v_reason := public.notification_suppression_reason_v1(
    v_row.host_id,
    v_row.entity_type,
    v_row.entity_key,
    v_row.entity_name,
    coalesce(v_row.signal_key, v_row.dedupe_key),
    clock_timestamp()
  );
  if v_reason is not null then
    return v_reason;
  end if;

  if v_row.signal_key is not null then
    select * into v_signal
    from public.notification_signal_state
    where signal_key = v_row.signal_key;

    if v_row.transition in ('opened', 'escalated') then
      if not found
        or not v_signal.active
        or v_row.occurred_at < v_signal.opened_at then
        return 'signal_recovered_before_delivery';
      end if;
    elsif v_row.transition = 'recovered' then
      if found and v_row.occurred_at < v_signal.opened_at then
        return 'superseded_by_new_incident';
      end if;

      if not exists (
        select 1
        from public.notification_outbox as delivered
        where delivered.signal_key = v_row.signal_key
          and delivered.transition in ('opened', 'escalated')
          and delivered.status = 'sent'
          and (
            not found
            or delivered.occurred_at >= v_signal.opened_at
          )
          and delivered.occurred_at <= v_row.occurred_at
      ) then
        return 'recovered_before_first_delivery';
      end if;
    end if;
  end if;

  return null;
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

create or replace function public.notification_backup_policy_retire_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_host_id uuid;
  v_backup_target text;
  v_game_mode text;
  v_backup_type text;
  v_base_signal_key text;
begin
  if tg_op = 'UPDATE' and not (old.enabled and not new.enabled) then
    return new;
  end if;

  v_host_id := old.host_id;
  v_backup_target := old.backup_target;
  v_game_mode := old.game_mode;
  v_backup_type := old.backup_type;
  v_base_signal_key := 'backup:' || v_host_id::text || ':' || v_backup_target || ':' || v_game_mode || ':' || v_backup_type;

  update public.notification_outbox
  set status = 'suppressed',
      suppression_reason = 'backup_policy_disabled',
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where signal_key in (
      v_base_signal_key || ':backup_age',
      v_base_signal_key || ':remote_sync',
      v_base_signal_key || ':retention',
      v_base_signal_key || ':restore_test'
    )
    and status in ('pending', 'retry', 'sending', 'suppressed');

  delete from public.notification_signal_state
  where signal_key in (
    v_base_signal_key || ':backup_age',
    v_base_signal_key || ':remote_sync',
    v_base_signal_key || ':retention',
    v_base_signal_key || ':restore_test'
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists notification_backup_policy_retire_trigger
  on public.backup_policies;
create trigger notification_backup_policy_retire_trigger
before update of enabled or delete on public.backup_policies
for each row
execute function public.notification_backup_policy_retire_v1();

revoke all on function public.apply_notification_signal_v1(
  text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_notification_signal_v1(
  text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text
) to service_role;

revoke all on function public.notification_delivery_block_reason_v1(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.notification_delivery_block_reason_v1(bigint, uuid)
  to service_role;

revoke all on function public.claim_notification_outbox_v1(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_outbox_v1(uuid, integer)
  to service_role;

revoke all on function public.notification_backup_policy_retire_v1()
  from public, anon, authenticated;

comment on function public.notification_delivery_block_reason_v1(bigint, uuid) is
  'Discord送信直前にClaim・Channel・動的Suppression・Signal lifecycleを再評価し、送信不可理由を返す。';
comment on function public.claim_notification_outbox_v1(uuid, integer) is
  '動的SuppressionとSignal順序を再評価し、同一Signalの古い通知がRecovery後や後続Transitionより後に配送されないようClaimする。';
comment on function public.notification_backup_policy_retire_v1() is
  'Backup Policy無効化/削除時にPolicy由来SLA Signalを退役し、未配送RowをSuppressedへ移す。';
