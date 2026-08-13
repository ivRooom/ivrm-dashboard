create extension if not exists pgcrypto with schema extensions;

-- Scheduler TokenはDB内部で生成し、平文はVault、通常テーブルにはSHA-256のみ保持する。
do $$
declare
  v_token text;
  v_hash text;
begin
  select secrets.decrypted_secret
  into v_token
  from vault.decrypted_secrets as secrets
  where secrets.name = 'ivrm_notification_dispatch_token'
  order by secrets.updated_at desc
  limit 1;

  if v_token is null then
    v_token := encode(extensions.gen_random_bytes(48), 'hex');
    perform vault.create_secret(
      v_token,
      'ivrm_notification_dispatch_token',
      'IVRM Notification Center scheduler token',
      null
    );
  end if;

  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into public.notification_dispatch_credentials (id, token_sha256)
  values (1, v_hash)
  on conflict (id) do update
  set token_sha256 = excluded.token_sha256,
      updated_at = clock_timestamp();
end;
$$;

-- Signal Key単位のadvisory transaction lockで、存在しない行の初回Open競合も直列化する。
-- また現在観測より古いイベントは状態を巻き戻さない。
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
    or p_source_type not in ('host', 'container', 'backup')
    or p_host_id is null
    or p_server_id is null or char_length(p_server_id) not between 1 and 128
    or p_entity_type not in ('host', 'container', 'backup')
    or p_entity_key is null or char_length(p_entity_key) not between 1 and 400
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_signal_type is null or char_length(p_signal_type) not between 1 and 80
    or p_active is null
    or p_severity not in ('warning', 'critical')
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

-- NULL failure_codeも通常Failureとして扱い、古いRunはapply_notification_signal_v1側で無視する。
create or replace function public.notification_backup_run_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_server_id text;
  v_entity_key text;
  v_base_signal_key text;
  v_detail_href text;
  v_at timestamptz;
begin
  select hosts.server_id
  into v_server_id
  from public.hosts as hosts
  where hosts.id = new.host_id;

  if v_server_id is null then
    return new;
  end if;

  v_entity_key := new.host_id::text || ':' || new.backup_target || ':' || new.game_mode || ':' || new.backup_type;
  v_base_signal_key := 'backup:' || v_entity_key;
  v_detail_href := '/backups?range=24h#backup-target-' || new.host_id::text || '-' || new.backup_target || '-' || new.game_mode || '-' || new.backup_type;
  v_at := coalesce(new.completed_at, new.started_at);

  if new.outcome = 'failed' and new.failure_code is distinct from 'checksum_failed' then
    perform public.apply_notification_signal_v1(
      v_base_signal_key || ':run_failure',
      'backup', new.host_id, v_server_id, 'backup', v_entity_key, new.backup_target,
      'run_failure', true, 'critical', v_at,
      'Backup失敗: ' || coalesce(new.failure_code, 'unknown'),
      new.backup_target || ' / Backup Run', v_detail_href
    );
  elsif new.outcome = 'success' then
    perform public.apply_notification_signal_v1(
      v_base_signal_key || ':run_failure',
      'backup', new.host_id, v_server_id, 'backup', v_entity_key, new.backup_target,
      'run_failure', false, 'warning', v_at,
      'Backup Runが成功しました',
      new.backup_target || ' / Backup Run', v_detail_href
    );
  end if;

  if new.failure_code is not distinct from 'checksum_failed'
     or (new.outcome = 'success' and new.sha256_verified is false) then
    perform public.apply_notification_signal_v1(
      v_base_signal_key || ':checksum',
      'backup', new.host_id, v_server_id, 'backup', v_entity_key, new.backup_target,
      'checksum', true, 'critical', v_at,
      'SHA-256検証失敗を確認しました',
      new.backup_target || ' / Checksum', v_detail_href
    );
  elsif new.outcome = 'success' and new.sha256_verified is true then
    perform public.apply_notification_signal_v1(
      v_base_signal_key || ':checksum',
      'backup', new.host_id, v_server_id, 'backup', v_entity_key, new.backup_target,
      'checksum', false, 'warning', v_at,
      'SHA-256検証が成功しました',
      new.backup_target || ' / Checksum', v_detail_href
    );
  end if;

  return new;
end;
$$;

-- Dispatcher URLは環境固有なのでVaultから取得する。別ProjectへTokenを送らない。
create or replace function public.kick_notification_dispatch_v1()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net
as $$
declare
  v_token text;
  v_dispatch_url text;
  v_request_id bigint;
begin
  if not exists (
    select 1
    from public.notification_channels as channels
    where channels.id = 1
      and channels.enabled
      and channels.configured
  ) then
    return null;
  end if;

  select secrets.decrypted_secret
  into v_token
  from vault.decrypted_secrets as secrets
  where secrets.name = 'ivrm_notification_dispatch_token'
  order by secrets.updated_at desc
  limit 1;

  if v_token is null or char_length(v_token) < 32 or char_length(v_token) > 256 then
    update public.notification_dispatch_state
    set last_invoked_at = clock_timestamp(),
        last_error_at = clock_timestamp(),
        last_error_code = 'scheduler_token_missing',
        updated_at = clock_timestamp()
    where id = 1;
    return null;
  end if;

  select secrets.decrypted_secret
  into v_dispatch_url
  from vault.decrypted_secrets as secrets
  where secrets.name = 'ivrm_notification_dispatch_url'
  order by secrets.updated_at desc
  limit 1;

  if v_dispatch_url is null
     or char_length(v_dispatch_url) > 512
     or v_dispatch_url !~ '^https://[a-z0-9]+[.]supabase[.]co/functions/v1/notification-dispatch$' then
    update public.notification_dispatch_state
    set last_invoked_at = clock_timestamp(),
        last_error_at = clock_timestamp(),
        last_error_code = 'dispatcher_url_missing',
        updated_at = clock_timestamp()
    where id = 1;
    return null;
  end if;

  select net.http_post(
    url := v_dispatch_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ivrm-dispatch-token', v_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) into v_request_id;

  return v_request_id;
end;
$$;

alter table public.notification_signal_state
  drop constraint if exists notification_signal_href_check;
alter table public.notification_signal_state
  add constraint notification_signal_href_check
  check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
  );

alter table public.notification_outbox
  drop constraint if exists notification_outbox_href_check;
alter table public.notification_outbox
  add constraint notification_outbox_href_check
  check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
  );

revoke all on function public.apply_notification_signal_v1(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.notification_backup_run_trigger_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.kick_notification_dispatch_v1()
  from public, anon, authenticated;
grant execute on function public.kick_notification_dispatch_v1()
  to service_role;

comment on function public.apply_notification_signal_v1(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text) is
  'Signal Key単位に直列化し、現在観測より古いイベントによる状態巻き戻しを拒否してOpen/Escalate/RecoveryをOutboxへ反映する。';
comment on function public.kick_notification_dispatch_v1() is
  'Channel有効時のみVaultのScheduler Tokenと環境固有Dispatcher URLを用いてNotification Edge Functionを起動する。';