create table if not exists public.notification_channels (
  id smallint primary key default 1,
  channel_type text not null default 'discord',
  display_name text not null default 'Discord Alerts',
  enabled boolean not null default false,
  configured boolean not null default false,
  last_delivery_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_channels_singleton_check check (id = 1),
  constraint notification_channels_type_check check (channel_type = 'discord'),
  constraint notification_channels_display_name_check check (char_length(display_name) between 1 and 80),
  constraint notification_channels_error_code_check check (last_error_code is null or char_length(last_error_code) <= 128)
);

insert into public.notification_channels (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.notification_suppressions (
  id bigint generated always as identity primary key,
  scope_type text not null,
  scope_key text not null default '*',
  reason text not null,
  starts_at timestamptz not null default clock_timestamp(),
  ends_at timestamptz,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_suppressions_scope_check
    check (scope_type in ('global', 'host', 'container', 'backup', 'signal')),
  constraint notification_suppressions_scope_key_check
    check (char_length(scope_key) between 1 and 400),
  constraint notification_suppressions_reason_check
    check (char_length(reason) between 1 and 256),
  constraint notification_suppressions_window_check
    check (ends_at is null or ends_at > starts_at)
);

create table if not exists public.notification_signal_state (
  signal_key text primary key,
  source_type text not null,
  host_id uuid not null references public.hosts(id) on delete cascade,
  server_id text not null,
  entity_type text not null,
  entity_key text not null,
  entity_name text not null,
  signal_type text not null,
  severity text not null,
  active boolean not null default true,
  opened_at timestamptz not null,
  last_seen_at timestamptz not null,
  recovered_at timestamptz,
  reason text not null,
  detail_href text not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_signal_key_check check (char_length(signal_key) between 1 and 500),
  constraint notification_signal_source_check check (source_type in ('host', 'container', 'backup')),
  constraint notification_signal_entity_type_check check (entity_type in ('host', 'container', 'backup')),
  constraint notification_signal_entity_key_check check (char_length(entity_key) between 1 and 400),
  constraint notification_signal_entity_name_check check (char_length(entity_name) between 1 and 256),
  constraint notification_signal_type_check check (char_length(signal_type) between 1 and 80),
  constraint notification_signal_severity_check check (severity in ('warning', 'critical')),
  constraint notification_signal_reason_check check (char_length(reason) between 1 and 1800),
  constraint notification_signal_href_check check (detail_href ~ '^/[A-Za-z0-9_./?=&%:+#-]{0,1000}$'),
  constraint notification_signal_recovery_check check (
    (active and recovered_at is null)
    or (not active and recovered_at is not null and recovered_at >= opened_at)
  )
);

create table if not exists public.notification_outbox (
  id bigint generated always as identity primary key,
  dedupe_key text not null unique,
  signal_key text,
  source_type text not null,
  host_id uuid not null references public.hosts(id) on delete cascade,
  server_id text not null,
  entity_type text not null,
  entity_key text not null,
  entity_name text not null,
  transition text not null,
  severity text not null,
  title text not null,
  message text not null,
  detail_href text not null,
  occurred_at timestamptz not null,
  status text not null default 'pending',
  suppression_reason text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  sent_at timestamptz,
  external_delivery_id text,
  last_http_status integer,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_outbox_dedupe_check check (char_length(dedupe_key) between 1 and 700),
  constraint notification_outbox_signal_key_check check (signal_key is null or char_length(signal_key) <= 500),
  constraint notification_outbox_source_check check (source_type in ('host', 'container', 'backup')),
  constraint notification_outbox_entity_type_check check (entity_type in ('host', 'container', 'backup')),
  constraint notification_outbox_entity_key_check check (char_length(entity_key) between 1 and 400),
  constraint notification_outbox_entity_name_check check (char_length(entity_name) between 1 and 256),
  constraint notification_outbox_transition_check check (transition in ('opened', 'escalated', 'recovered', 'event')),
  constraint notification_outbox_severity_check check (severity in ('info', 'warning', 'critical', 'recovery')),
  constraint notification_outbox_title_check check (char_length(title) between 1 and 160),
  constraint notification_outbox_message_check check (char_length(message) between 1 and 1800),
  constraint notification_outbox_href_check check (detail_href ~ '^/[A-Za-z0-9_./?=&%:+#-]{0,1000}$'),
  constraint notification_outbox_status_check check (status in ('pending', 'sending', 'sent', 'retry', 'failed', 'suppressed')),
  constraint notification_outbox_suppression_check check (suppression_reason is null or char_length(suppression_reason) <= 256),
  constraint notification_outbox_attempts_check check (attempts between 0 and 20),
  constraint notification_outbox_claim_check check (
    (status = 'sending' and claim_token is not null and claimed_at is not null)
    or (status <> 'sending')
  ),
  constraint notification_outbox_sent_check check (sent_at is null or status = 'sent'),
  constraint notification_outbox_http_check check (last_http_status is null or last_http_status between 100 and 599),
  constraint notification_outbox_external_id_check check (external_delivery_id is null or char_length(external_delivery_id) <= 128),
  constraint notification_outbox_error_code_check check (last_error_code is null or char_length(last_error_code) <= 128)
);

create table if not exists public.notification_dispatch_credentials (
  id smallint primary key default 1,
  token_sha256 text not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_dispatch_credentials_singleton_check check (id = 1),
  constraint notification_dispatch_credentials_sha_check check (token_sha256 ~ '^[a-f0-9]{64}$')
);

create table if not exists public.notification_dispatch_state (
  id smallint primary key default 1,
  last_invoked_at timestamptz,
  last_success_at timestamptz,
  last_batch_count integer not null default 0,
  last_error_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_dispatch_state_singleton_check check (id = 1),
  constraint notification_dispatch_state_batch_check check (last_batch_count between 0 and 100),
  constraint notification_dispatch_state_error_check check (last_error_code is null or char_length(last_error_code) <= 128)
);

insert into public.notification_dispatch_state (id)
values (1)
on conflict (id) do nothing;

create index if not exists notification_suppressions_active_idx
  on public.notification_suppressions (enabled, starts_at, ends_at, scope_type, scope_key);

create index if not exists notification_signal_state_active_idx
  on public.notification_signal_state (active, severity, opened_at desc);

create index if not exists notification_signal_state_host_idx
  on public.notification_signal_state (host_id, active, updated_at desc);

create index if not exists notification_outbox_delivery_idx
  on public.notification_outbox (status, next_attempt_at, id)
  where status in ('pending', 'retry', 'sending');

create index if not exists notification_outbox_occurred_idx
  on public.notification_outbox (occurred_at desc, id desc);

alter table public.notification_channels enable row level security;
alter table public.notification_channels force row level security;
alter table public.notification_suppressions enable row level security;
alter table public.notification_suppressions force row level security;
alter table public.notification_signal_state enable row level security;
alter table public.notification_signal_state force row level security;
alter table public.notification_outbox enable row level security;
alter table public.notification_outbox force row level security;
alter table public.notification_dispatch_credentials enable row level security;
alter table public.notification_dispatch_credentials force row level security;
alter table public.notification_dispatch_state enable row level security;
alter table public.notification_dispatch_state force row level security;

revoke all on table public.notification_channels from public, anon, authenticated, service_role;
revoke all on table public.notification_suppressions from public, anon, authenticated, service_role;
revoke all on table public.notification_signal_state from public, anon, authenticated, service_role;
revoke all on table public.notification_outbox from public, anon, authenticated, service_role;
revoke all on table public.notification_dispatch_credentials from public, anon, authenticated, service_role;
revoke all on table public.notification_dispatch_state from public, anon, authenticated, service_role;

create or replace function public.notification_severity_rank_v1(p_severity text)
returns integer
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_severity
    when 'critical' then 2
    when 'warning' then 1
    else 0
  end;
$$;

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

create or replace function public.enqueue_notification_v1(
  p_dedupe_key text,
  p_signal_key text,
  p_source_type text,
  p_host_id uuid,
  p_server_id text,
  p_entity_type text,
  p_entity_key text,
  p_entity_name text,
  p_transition text,
  p_severity text,
  p_title text,
  p_message text,
  p_detail_href text,
  p_occurred_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_suppression_reason text;
  v_status text;
  v_id bigint;
begin
  if p_dedupe_key is null or char_length(p_dedupe_key) not between 1 and 700
    or p_source_type not in ('host', 'container', 'backup')
    or p_host_id is null
    or p_server_id is null or char_length(p_server_id) not between 1 and 128
    or p_entity_type not in ('host', 'container', 'backup')
    or p_entity_key is null or char_length(p_entity_key) not between 1 and 400
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_transition not in ('opened', 'escalated', 'recovered', 'event')
    or p_severity not in ('info', 'warning', 'critical', 'recovery')
    or p_title is null or char_length(p_title) not between 1 and 160
    or p_message is null or char_length(p_message) not between 1 and 1800
    or p_detail_href is null or p_detail_href !~ '^/[A-Za-z0-9_./?=&%:+#-]{0,1000}$'
    or p_occurred_at is null then
    raise exception 'notification_payload_invalid' using errcode = '22023';
  end if;

  v_suppression_reason := public.notification_suppression_reason_v1(
    p_host_id,
    p_entity_type,
    p_entity_key,
    p_entity_name,
    coalesce(p_signal_key, p_dedupe_key),
    p_occurred_at
  );
  v_status := case when v_suppression_reason is null then 'pending' else 'suppressed' end;

  insert into public.notification_outbox (
    dedupe_key,
    signal_key,
    source_type,
    host_id,
    server_id,
    entity_type,
    entity_key,
    entity_name,
    transition,
    severity,
    title,
    message,
    detail_href,
    occurred_at,
    status,
    suppression_reason
  ) values (
    p_dedupe_key,
    p_signal_key,
    p_source_type,
    p_host_id,
    p_server_id,
    p_entity_type,
    p_entity_key,
    p_entity_name,
    p_transition,
    p_severity,
    p_title,
    p_message,
    p_detail_href,
    p_occurred_at,
    v_status,
    v_suppression_reason
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select outbox.id into v_id
    from public.notification_outbox as outbox
    where outbox.dedupe_key = p_dedupe_key;
  end if;

  return v_id;
end;
$$;

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
    or p_detail_href is null or p_detail_href !~ '^/[A-Za-z0-9_./?=&%:+#-]{0,1000}$' then
    raise exception 'notification_signal_invalid' using errcode = '22023';
  end if;

  select * into v_current
  from public.notification_signal_state
  where signal_key = p_signal_key
  for update;

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
          last_seen_at = greatest(last_seen_at, p_occurred_at),
          reason = p_reason,
          detail_href = p_detail_href,
          updated_at = clock_timestamp()
      where signal_key = p_signal_key;
      v_transition := 'escalated';
    else
      update public.notification_signal_state
      set last_seen_at = greatest(last_seen_at, p_occurred_at),
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
        last_seen_at = greatest(last_seen_at, p_occurred_at),
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

create or replace function public.notification_monitoring_event_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_server_id text;
  v_signal_key text;
  v_entity_key text;
  v_signal_type text;
  v_title text;
  v_reason text;
  v_active boolean;
  v_is_recovery boolean := false;
  v_severity text;
  v_detail_href text;
begin
  select hosts.server_id into v_server_id
  from public.hosts as hosts
  where hosts.id = new.host_id;

  if v_server_id is null then
    return new;
  end if;

  v_entity_key := new.host_id::text || ':' || new.container_name;
  v_detail_href := '/containers/' || v_server_id || '/' || new.container_name || '?range=24h';

  if new.event_type in ('state_changed', 'health_changed', 'exit_code_changed') then
    v_signal_type := new.event_type;
    v_signal_key := 'container:' || v_entity_key || ':' || new.event_type;
    v_title := new.container_name || ' / ' || case new.event_type
      when 'state_changed' then 'State'
      when 'health_changed' then 'Health'
      else 'ExitCode'
    end;
    v_reason := case new.event_type
      when 'state_changed' then 'State ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown')
      when 'health_changed' then 'Health ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown')
      else 'ExitCode ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown')
    end;

    if new.severity in ('warning', 'critical') then
      v_active := true;
      v_severity := new.severity;
    else
      if new.severity = 'recovery' then
        v_is_recovery := true;
      elsif new.event_type = 'health_changed' and new.to_value = 'healthy' then
        v_is_recovery := true;
      elsif new.event_type = 'exit_code_changed' and new.to_value ~ '^-?[0-9]+$' and new.to_value::integer = 0 then
        v_is_recovery := true;
      elsif new.event_type = 'state_changed' then
        v_is_recovery := (
          (new.expected_state = 'stopped' and new.to_value in ('exited', 'created'))
          or (new.expected_state = 'absent' and new.to_value = 'not_found')
          or (coalesce(new.expected_state, 'running') not in ('stopped', 'absent') and new.to_value = 'running')
        );
      end if;
      v_active := not v_is_recovery;
      v_severity := 'warning';
    end if;

    if new.severity in ('warning', 'critical') or v_is_recovery then
      perform public.apply_notification_signal_v1(
        v_signal_key,
        'container',
        new.host_id,
        v_server_id,
        'container',
        v_entity_key,
        new.container_name,
        v_signal_type,
        v_active,
        v_severity,
        new.occurred_at,
        v_reason,
        v_title,
        v_detail_href
      );
    end if;
  elsif new.event_type = 'oom_killed' then
    perform public.enqueue_notification_v1(
      'monitoring-event:' || new.id::text,
      null,
      'container',
      new.host_id,
      v_server_id,
      'container',
      v_entity_key,
      new.container_name,
      'event',
      'critical',
      new.container_name || ' / OOMKilled',
      'OOMKilledを検知しました',
      v_detail_href,
      new.occurred_at
    );
  elsif new.event_type = 'restart_count_increased' then
    perform public.enqueue_notification_v1(
      'monitoring-event:' || new.id::text,
      null,
      'container',
      new.host_id,
      v_server_id,
      'container',
      v_entity_key,
      new.container_name,
      'event',
      'warning',
      new.container_name || ' / Restart',
      'RestartCount ' || coalesce(new.from_value, 'unknown') || ' → ' || coalesce(new.to_value, 'unknown'),
      v_detail_href,
      new.occurred_at
    );
  end if;

  return new;
end;
$$;

create or replace function public.notification_backup_run_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_server_id text;
  v_display_name text;
  v_entity_key text;
  v_base_signal_key text;
  v_detail_href text;
  v_at timestamptz;
begin
  select hosts.server_id, hosts.display_name
  into v_server_id, v_display_name
  from public.hosts as hosts
  where hosts.id = new.host_id;

  if v_server_id is null then
    return new;
  end if;

  v_entity_key := new.host_id::text || ':' || new.backup_target || ':' || new.game_mode || ':' || new.backup_type;
  v_base_signal_key := 'backup:' || v_entity_key;
  v_detail_href := '/backups?range=24h#backup-target-' || new.host_id::text || '-' || new.backup_target || '-' || new.game_mode || '-' || new.backup_type;
  v_at := coalesce(new.completed_at, new.started_at);

  if new.outcome = 'failed' and new.failure_code <> 'checksum_failed' then
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

  if new.failure_code = 'checksum_failed'
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

drop trigger if exists notification_monitoring_event_after_insert on public.monitoring_events;
create trigger notification_monitoring_event_after_insert
after insert on public.monitoring_events
for each row execute function public.notification_monitoring_event_trigger_v1();

drop trigger if exists notification_backup_run_after_write on public.backup_runs;
create trigger notification_backup_run_after_write
after insert or update of outcome, completed_at, sha256_verified, failure_code on public.backup_runs
for each row execute function public.notification_backup_run_trigger_v1();

create or replace function public.reconcile_notification_scheduled_signals_v1()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_host record;
  v_backup record;
  v_age_seconds double precision;
  v_entity_key text;
  v_base_signal_key text;
  v_detail_href text;
  v_count integer := 0;
begin
  for v_host in
    select
      hosts.id as host_id,
      hosts.server_id,
      hosts.display_name,
      latest.received_at
    from public.hosts as hosts
    left join lateral (
      select heartbeats.received_at
      from public.agent_heartbeats as heartbeats
      where heartbeats.host_id = hosts.id
      order by heartbeats.received_at desc, heartbeats.id desc
      limit 1
    ) as latest on true
    where hosts.enabled
  loop
    if v_host.received_at is null then
      continue;
    end if;

    v_age_seconds := extract(epoch from (v_now - v_host.received_at));
    v_entity_key := v_host.host_id::text;
    v_detail_href := '/hosts/' || v_host.server_id || '?range=24h';

    if v_age_seconds > 45 then
      perform public.apply_notification_signal_v1(
        'host:' || v_host.host_id::text || ':heartbeat',
        'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
        'heartbeat', true, 'warning', v_host.received_at + interval '45 seconds',
        'Heartbeatが45秒以上更新されていません',
        v_host.display_name || ' / Heartbeat', v_detail_href
      );
      v_count := v_count + 1;

      if v_age_seconds > 180 then
        perform public.apply_notification_signal_v1(
          'host:' || v_host.host_id::text || ':heartbeat',
          'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
          'heartbeat', true, 'critical', v_host.received_at + interval '180 seconds',
          'Heartbeatが180秒以上更新されていません',
          v_host.display_name || ' / Heartbeat', v_detail_href
        );
      end if;
    else
      perform public.apply_notification_signal_v1(
        'host:' || v_host.host_id::text || ':heartbeat',
        'host', v_host.host_id, v_host.server_id, 'host', v_entity_key, v_host.display_name,
        'heartbeat', false, 'warning', v_host.received_at,
        'Heartbeat受信を確認しました',
        v_host.display_name || ' / Heartbeat', v_detail_href
      );
    end if;
  end loop;

  for v_backup in
    select
      policies.id as policy_id,
      policies.host_id,
      hosts.server_id,
      hosts.display_name,
      policies.backup_target,
      policies.game_mode,
      policies.backup_type,
      policies.remote_sync_required,
      policies.warning_after_seconds,
      policies.critical_after_seconds,
      policies.remote_sync_warning_seconds,
      policies.restore_test_warning_seconds,
      success.completed_at,
      success.remote_synced_at,
      success.restore_tested_at,
      success.retention_expires_at
    from public.backup_policies as policies
    join public.hosts as hosts on hosts.id = policies.host_id and hosts.enabled
    left join lateral (
      select runs.completed_at, runs.remote_synced_at, runs.restore_tested_at, runs.retention_expires_at
      from public.backup_runs as runs
      where runs.host_id = policies.host_id
        and runs.backup_target = policies.backup_target
        and runs.game_mode = policies.game_mode
        and runs.backup_type = policies.backup_type
        and runs.outcome = 'success'
        and runs.completed_at is not null
      order by runs.completed_at desc, runs.id desc
      limit 1
    ) as success on true
    where policies.enabled
  loop
    if v_backup.completed_at is null then
      continue;
    end if;

    v_entity_key := v_backup.host_id::text || ':' || v_backup.backup_target || ':' || v_backup.game_mode || ':' || v_backup.backup_type;
    v_base_signal_key := 'backup:' || v_entity_key;
    v_detail_href := '/backups?range=24h#backup-target-' || v_backup.host_id::text || '-' || v_backup.backup_target || '-' || v_backup.game_mode || '-' || v_backup.backup_type;
    v_age_seconds := extract(epoch from (v_now - v_backup.completed_at));

    if v_age_seconds > v_backup.warning_after_seconds then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':backup_age',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'backup_age', true, 'warning', v_backup.completed_at + make_interval(secs => v_backup.warning_after_seconds),
        '最新成功BackupがWarning SLAを超過しました',
        v_backup.backup_target || ' / Backup Age', v_detail_href
      );
      if v_age_seconds > v_backup.critical_after_seconds then
        perform public.apply_notification_signal_v1(
          v_base_signal_key || ':backup_age',
          'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
          'backup_age', true, 'critical', v_backup.completed_at + make_interval(secs => v_backup.critical_after_seconds),
          '最新成功BackupがCritical SLAを超過しました',
          v_backup.backup_target || ' / Backup Age', v_detail_href
        );
      end if;
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':backup_age',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'backup_age', false, 'warning', v_backup.completed_at,
        '最新成功BackupはSLA内です',
        v_backup.backup_target || ' / Backup Age', v_detail_href
      );
    end if;

    if v_backup.remote_sync_required
       and v_backup.remote_synced_at is null
       and v_now > v_backup.completed_at + make_interval(secs => v_backup.remote_sync_warning_seconds) then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':remote_sync',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'remote_sync', true, 'warning', v_backup.completed_at + make_interval(secs => v_backup.remote_sync_warning_seconds),
        'Remote SyncがSLA内に完了していません',
        v_backup.backup_target || ' / Remote Sync', v_detail_href
      );
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':remote_sync',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'remote_sync', false, 'warning', coalesce(v_backup.remote_synced_at, v_backup.completed_at),
        case when v_backup.remote_sync_required then 'Remote Sync完了を確認しました' else 'Remote Syncは必須ではありません' end,
        v_backup.backup_target || ' / Remote Sync', v_detail_href
      );
    end if;

    if v_backup.retention_expires_at is not null and v_backup.retention_expires_at <= v_now then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':retention',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'retention', true, 'critical', v_backup.retention_expires_at,
        '最新成功BackupのRetention期限を超過しました',
        v_backup.backup_target || ' / Retention', v_detail_href
      );
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':retention',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'retention', false, 'warning', v_backup.completed_at,
        'Retention期限は有効です',
        v_backup.backup_target || ' / Retention', v_detail_href
      );
    end if;

    if v_backup.restore_tested_at is null then
      if v_now > v_backup.completed_at + make_interval(secs => v_backup.restore_test_warning_seconds) then
        perform public.apply_notification_signal_v1(
          v_base_signal_key || ':restore_test',
          'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
          'restore_test', true, 'warning', v_backup.completed_at + make_interval(secs => v_backup.restore_test_warning_seconds),
          'Restore Testが長期間実施されていません',
          v_backup.backup_target || ' / Restore Test', v_detail_href
        );
      else
        perform public.apply_notification_signal_v1(
          v_base_signal_key || ':restore_test',
          'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
          'restore_test', false, 'warning', v_backup.completed_at,
          'Restore Test警告SLA内です',
          v_backup.backup_target || ' / Restore Test', v_detail_href
        );
      end if;
    elsif v_now > v_backup.restore_tested_at + make_interval(secs => v_backup.restore_test_warning_seconds) then
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':restore_test',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'restore_test', true, 'warning', v_backup.restore_tested_at + make_interval(secs => v_backup.restore_test_warning_seconds),
        'Restore Testの鮮度がWarning SLAを超過しました',
        v_backup.backup_target || ' / Restore Test', v_detail_href
      );
    else
      perform public.apply_notification_signal_v1(
        v_base_signal_key || ':restore_test',
        'backup', v_backup.host_id, v_backup.server_id, 'backup', v_entity_key, v_backup.backup_target,
        'restore_test', false, 'warning', v_backup.restore_tested_at,
        'Restore Testの鮮度を確認しました',
        v_backup.backup_target || ' / Restore Test', v_detail_href
      );
    end if;
  end loop;

  return v_count;
end;
$$;

create or replace function public.verify_notification_dispatch_token_v1(p_token_sha256 text)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select exists (
    select 1
    from public.notification_dispatch_credentials as credentials
    where credentials.id = 1
      and credentials.token_sha256 = p_token_sha256
      and p_token_sha256 ~ '^[a-f0-9]{64}$'
  );
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

  update public.notification_outbox
  set status = 'retry',
      claim_token = null,
      claimed_at = null,
      next_attempt_at = clock_timestamp(),
      last_error_code = 'claim_timeout',
      updated_at = clock_timestamp()
  where status = 'sending'
    and claimed_at < clock_timestamp() - interval '5 minutes';

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

create or replace function public.complete_notification_delivery_v1(
  p_id bigint,
  p_claim_token uuid,
  p_success boolean,
  p_http_status integer default null,
  p_external_delivery_id text default null,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_attempts integer;
  v_status text;
  v_backoff_seconds integer;
begin
  if p_id is null or p_id < 1 or p_claim_token is null or p_success is null
    or (p_http_status is not null and p_http_status not between 100 and 599)
    or (p_external_delivery_id is not null and char_length(p_external_delivery_id) > 128)
    or (p_error_code is not null and char_length(p_error_code) > 128) then
    raise exception 'notification_complete_invalid' using errcode = '22023';
  end if;

  select attempts into v_attempts
  from public.notification_outbox
  where id = p_id
    and status = 'sending'
    and claim_token = p_claim_token
  for update;

  if not found then
    return 'claim_mismatch';
  end if;

  if p_success then
    update public.notification_outbox
    set status = 'sent',
        sent_at = clock_timestamp(),
        external_delivery_id = p_external_delivery_id,
        last_http_status = p_http_status,
        last_error_code = null,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where id = p_id;

    update public.notification_channels
    set last_delivery_at = clock_timestamp(),
        last_error_code = null,
        updated_at = clock_timestamp()
    where id = 1;

    return 'sent';
  end if;

  if v_attempts >= 5 then
    v_status := 'failed';
    v_backoff_seconds := 0;
  else
    v_status := 'retry';
    v_backoff_seconds := least(1800, 60 * (1 << greatest(0, v_attempts - 1)));
  end if;

  update public.notification_outbox
  set status = v_status,
      next_attempt_at = case
        when v_status = 'retry' then clock_timestamp() + make_interval(secs => v_backoff_seconds)
        else next_attempt_at
      end,
      last_http_status = p_http_status,
      last_error_code = coalesce(p_error_code, 'delivery_failed'),
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where id = p_id;

  update public.notification_channels
  set last_error_at = clock_timestamp(),
      last_error_code = coalesce(p_error_code, 'delivery_failed'),
      updated_at = clock_timestamp()
  where id = 1;

  return v_status;
end;
$$;

create or replace function public.mark_notification_dispatch_v1(
  p_success boolean,
  p_batch_count integer default 0,
  p_error_code text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_success is null or p_batch_count is null or p_batch_count < 0 or p_batch_count > 100
    or (p_error_code is not null and char_length(p_error_code) > 128) then
    raise exception 'notification_dispatch_state_invalid' using errcode = '22023';
  end if;

  update public.notification_dispatch_state
  set last_invoked_at = clock_timestamp(),
      last_success_at = case when p_success then clock_timestamp() else last_success_at end,
      last_batch_count = p_batch_count,
      last_error_at = case when p_success then last_error_at else clock_timestamp() end,
      last_error_code = case when p_success then null else coalesce(p_error_code, 'dispatch_failed') end,
      updated_at = clock_timestamp()
  where id = 1;
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
end;
$$;

create or replace function public.get_notification_center_summary_v1()
returns table (
  generated_at timestamptz,
  channel_enabled boolean,
  channel_configured boolean,
  channel_display_name text,
  active_signal_count bigint,
  active_critical_count bigint,
  active_warning_count bigint,
  pending_count bigint,
  retry_count bigint,
  failed_count bigint,
  suppressed_count bigint,
  sent_24h_count bigint,
  active_suppression_count bigint,
  last_delivery_at timestamptz,
  channel_last_error_at timestamptz,
  channel_last_error_code text,
  dispatcher_last_invoked_at timestamptz,
  dispatcher_last_success_at timestamptz,
  dispatcher_last_error_at timestamptz,
  dispatcher_last_error_code text
)
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select
    statement_timestamp(),
    channels.enabled,
    channels.configured,
    channels.display_name,
    (select count(*) from public.notification_signal_state where active),
    (select count(*) from public.notification_signal_state where active and severity = 'critical'),
    (select count(*) from public.notification_signal_state where active and severity = 'warning'),
    (select count(*) from public.notification_outbox where status = 'pending'),
    (select count(*) from public.notification_outbox where status = 'retry'),
    (select count(*) from public.notification_outbox where status = 'failed'),
    (select count(*) from public.notification_outbox where status = 'suppressed'),
    (select count(*) from public.notification_outbox where status = 'sent' and sent_at >= statement_timestamp() - interval '24 hours'),
    (select count(*) from public.notification_suppressions where enabled and starts_at <= statement_timestamp() and (ends_at is null or ends_at > statement_timestamp())),
    channels.last_delivery_at,
    channels.last_error_at,
    channels.last_error_code,
    dispatch.last_invoked_at,
    dispatch.last_success_at,
    dispatch.last_error_at,
    dispatch.last_error_code
  from public.notification_channels as channels
  cross join public.notification_dispatch_state as dispatch
  where channels.id = 1 and dispatch.id = 1;
$$;

create or replace function public.get_notification_active_signals_v1(p_limit integer default 100)
returns table (
  signal_key text,
  source_type text,
  server_id text,
  entity_type text,
  entity_name text,
  signal_type text,
  severity text,
  opened_at timestamptz,
  last_seen_at timestamptz,
  reason text,
  detail_href text
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'notification_signal_query_invalid' using errcode = '22023';
  end if;

  return query
  select
    signals.signal_key,
    signals.source_type,
    signals.server_id,
    signals.entity_type,
    signals.entity_name,
    signals.signal_type,
    signals.severity,
    signals.opened_at,
    signals.last_seen_at,
    signals.reason,
    signals.detail_href
  from public.notification_signal_state as signals
  where signals.active
  order by
    case signals.severity when 'critical' then 1 else 2 end,
    signals.opened_at,
    signals.signal_key
  limit p_limit;
end;
$$;

create or replace function public.get_notification_deliveries_v1(
  p_limit integer default 100,
  p_before_occurred_at timestamptz default null,
  p_before_id bigint default null
)
returns table (
  row_id bigint,
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
  status text,
  suppression_reason text,
  attempts integer,
  sent_at timestamptz,
  last_http_status integer,
  last_error_code text
)
language plpgsql
security definer
set search_path = pg_catalog, public
stable
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200
    or ((p_before_occurred_at is null) <> (p_before_id is null)) then
    raise exception 'notification_delivery_query_invalid' using errcode = '22023';
  end if;

  return query
  select
    outbox.id,
    outbox.source_type,
    outbox.server_id,
    outbox.entity_type,
    outbox.entity_name,
    outbox.transition,
    outbox.severity,
    outbox.title,
    outbox.message,
    outbox.detail_href,
    outbox.occurred_at,
    outbox.status,
    outbox.suppression_reason,
    outbox.attempts,
    outbox.sent_at,
    outbox.last_http_status,
    outbox.last_error_code
  from public.notification_outbox as outbox
  where p_before_occurred_at is null
     or (outbox.occurred_at, outbox.id) < (p_before_occurred_at, p_before_id)
  order by outbox.occurred_at desc, outbox.id desc
  limit p_limit;
end;
$$;

create or replace function public.get_notification_suppressions_v1()
returns table (
  row_id bigint,
  scope_type text,
  scope_key text,
  reason text,
  starts_at timestamptz,
  ends_at timestamptz
)
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select
    suppressions.id,
    suppressions.scope_type,
    suppressions.scope_key,
    suppressions.reason,
    suppressions.starts_at,
    suppressions.ends_at
  from public.notification_suppressions as suppressions
  where suppressions.enabled
    and suppressions.starts_at <= statement_timestamp()
    and (suppressions.ends_at is null or suppressions.ends_at > statement_timestamp())
  order by suppressions.starts_at desc, suppressions.id desc;
$$;

select cron.schedule(
  'ivrm-notification-reconcile-v1',
  '* * * * *',
  $cron$select public.reconcile_notification_scheduled_signals_v1();$cron$
);

revoke all on function public.notification_severity_rank_v1(text) from public, anon, authenticated;
revoke all on function public.notification_suppression_reason_v1(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.enqueue_notification_v1(text, text, text, uuid, text, text, text, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.apply_notification_signal_v1(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text) from public, anon, authenticated;
revoke all on function public.reconcile_notification_scheduled_signals_v1() from public, anon, authenticated;
revoke all on function public.verify_notification_dispatch_token_v1(text) from public, anon, authenticated;
revoke all on function public.claim_notification_outbox_v1(uuid, integer) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery_v1(bigint, uuid, boolean, integer, text, text) from public, anon, authenticated;
revoke all on function public.mark_notification_dispatch_v1(boolean, integer, text) from public, anon, authenticated;
revoke all on function public.set_notification_channel_v1(boolean, boolean, text) from public, anon, authenticated;
revoke all on function public.get_notification_center_summary_v1() from public, anon, authenticated;
revoke all on function public.get_notification_active_signals_v1(integer) from public, anon, authenticated;
revoke all on function public.get_notification_deliveries_v1(integer, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.get_notification_suppressions_v1() from public, anon, authenticated;

revoke all on function public.notification_severity_rank_v1(text) from service_role;
revoke all on function public.notification_suppression_reason_v1(uuid, text, text, text, text, timestamptz) from service_role;
revoke all on function public.enqueue_notification_v1(text, text, text, uuid, text, text, text, text, text, text, text, text, text, timestamptz) from service_role;
revoke all on function public.apply_notification_signal_v1(text, text, uuid, text, text, text, text, text, boolean, text, timestamptz, text, text, text) from service_role;

revoke all on function public.notification_monitoring_event_trigger_v1() from public, anon, authenticated, service_role;
revoke all on function public.notification_backup_run_trigger_v1() from public, anon, authenticated, service_role;

grant execute on function public.reconcile_notification_scheduled_signals_v1() to service_role;
grant execute on function public.verify_notification_dispatch_token_v1(text) to service_role;
grant execute on function public.claim_notification_outbox_v1(uuid, integer) to service_role;
grant execute on function public.complete_notification_delivery_v1(bigint, uuid, boolean, integer, text, text) to service_role;
grant execute on function public.mark_notification_dispatch_v1(boolean, integer, text) to service_role;
grant execute on function public.set_notification_channel_v1(boolean, boolean, text) to service_role;
grant execute on function public.get_notification_center_summary_v1() to service_role;
grant execute on function public.get_notification_active_signals_v1(integer) to service_role;
grant execute on function public.get_notification_deliveries_v1(integer, timestamptz, bigint) to service_role;
grant execute on function public.get_notification_suppressions_v1() to service_role;

comment on table public.notification_signal_state is
  'Host / Container / Backupの通知Signal現在状態。通知配送ではなくIncident-like lifecycleのSource of Truth。';
comment on table public.notification_outbox is
  'Discord等への通知配送をDurableに保持するOutbox。SecretやWebhook URLは保存しない。';
comment on function public.reconcile_notification_scheduled_signals_v1() is
  'Agent停止中でもHost HeartbeatとBackup SLAを毎分再評価し、Signal open/escalate/recoveryをOutboxへ反映する。';