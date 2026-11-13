-- Issue #215: group a full cloud-collector ingest outage into a single
-- first-time notification, and label it as a Vercel free-tier pause when
-- the console probe detects DEPLOYMENT_DISABLED.
--
-- Background: on 2026-11-13 the Vercel team was paused for exceeding the
-- Hobby fair-use limits (Fluid Active CPU). console.ivrm.jp returned
-- HTTP 402 DEPLOYMENT_DISABLED, every collector stopped ingesting, and
-- the per-target collector_stale alerts fired one per target (plus
-- escalations) for a single root cause, without saying anywhere that
-- the cause was a usage-limit pause.

-- 1. Console ingest health probe (singleton). Written once a minute by
--    ivrm-dash-minutely.sh through a direct database connection, so it
--    keeps working while the console itself is disabled.
create table public.console_ingest_health (
  id smallint primary key check (id = 1),
  checked_at timestamptz not null,
  http_status integer not null check (http_status between 0 and 999),
  deployment_disabled boolean not null,
  detail text not null check (char_length(detail) between 1 and 200)
);
alter table public.console_ingest_health enable row level security;
revoke all on public.console_ingest_health from public, anon, authenticated;
grant select on public.console_ingest_health to service_role;

create or replace function public.record_console_ingest_health_v1(
  p_http_status integer,
  p_deployment_disabled boolean,
  p_detail text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_http_status is null or p_http_status not between 0 and 999
    or p_deployment_disabled is null
    or p_detail is null or char_length(p_detail) not between 1 and 200 then
    raise exception 'console_ingest_health_invalid' using errcode = '22023';
  end if;
  insert into public.console_ingest_health (id, checked_at, http_status, deployment_disabled, detail)
  values (1, clock_timestamp(), p_http_status, p_deployment_disabled, p_detail)
  on conflict (id) do update
    set checked_at = excluded.checked_at,
        http_status = excluded.http_status,
        deployment_disabled = excluded.deployment_disabled,
        detail = excluded.detail;
end;
$$;
revoke all on function public.record_console_ingest_health_v1(integer, boolean, text) from public, anon, authenticated;
grant execute on function public.record_console_ingest_health_v1(integer, boolean, text) to service_role;

-- 2. apply_cloud_monitor_signal_v2: same state machine as v1, with two
--    additions.
--    * p_notify = false records state transitions silently (used for
--      per-target signals while a grouped ingest outage is active).
--    * A still-active signal that was never announced (no opened /
--      escalated outbox row since opened_at, e.g. it opened silently
--      during a grouped outage) emits its opened notification on the
--      first notified evaluation, and a recovery is only announced when
--      an opened / escalated row exists for the current opening.
create or replace function public.apply_cloud_monitor_signal_v2(
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
  p_detail_href text,
  p_notify boolean
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
  v_announced boolean;
begin
  if p_signal_key is null or char_length(p_signal_key) not between 1 and 500
    or p_source_type is null or p_source_type not in ('cloud')
    or p_host_id is not null
    or p_server_id is distinct from 'ivrm'
    or p_entity_type is null or p_entity_type not in ('cloud')
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
    or p_detail_href !~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
    or p_notify is null then
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
      -- Catch-up: a signal that opened silently (grouped outage) and is
      -- still active announces its opening on the first notified pass.
      select exists(
        select 1 from public.notification_outbox
        where signal_key = p_signal_key
          and transition in ('opened', 'escalated')
          and occurred_at >= v_current.opened_at
      ) into v_announced;
      if p_notify and not v_announced then
        v_transition := 'opened';
      else
        return 'unchanged';
      end if;
    end if;

    if not p_notify then
      return v_transition;
    end if;

    v_delivery_severity := p_severity;
    v_title := case when v_transition = 'escalated' then '重大化: ' || p_title else p_title end;
  else
    if not found or not v_current.active then
      return 'unchanged';
    end if;

    select exists(
      select 1 from public.notification_outbox
      where signal_key = p_signal_key
        and transition in ('opened', 'escalated')
        and occurred_at >= v_current.opened_at
    ) into v_announced;

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

    -- A silently-tracked opening was never announced, so its recovery
    -- is not announced either.
    if not p_notify or not v_announced then
      return 'recovered';
    end if;

    v_transition := 'recovered';
    v_delivery_severity := 'recovery';
    v_title := '復旧: ' || p_title;
  end if;

  v_dedupe_key := p_signal_key || ':' || v_transition || ':' || to_char(p_occurred_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');

  perform public.enqueue_cloud_notification_v1(
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

-- v1 keeps its original signature and behaviour for existing callers.
create or replace function public.apply_cloud_monitor_signal_v1(
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
begin
  return public.apply_cloud_monitor_signal_v2(
    p_signal_key, p_source_type, p_host_id, p_server_id, p_entity_type,
    p_entity_key, p_entity_name, p_signal_type, p_active, p_severity,
    p_occurred_at, p_reason, p_title, p_detail_href, true
  );
end;
$$;
revoke all on function public.apply_cloud_monitor_signal_v2(text,text,uuid,text,text,text,text,text,boolean,text,timestamptz,text,text,text,boolean) from public, anon, authenticated;

-- 3. reconcile: when every enabled target is stale (and there are at
--    least two), the collectors as a whole have stopped. Announce that
--    once through the grouped signal cloud:ingest-outage and track the
--    per-target signals silently until the outage clears.
create or replace function public.reconcile_cloud_monitor_signals_v1()
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.cloud_monitor_targets%rowtype;
  v_stale boolean;
  v_count integer := 0;
  v_key text;
  v_total integer := 0;
  v_stale_total integer := 0;
  v_outage boolean := false;
  v_probe public.console_ingest_health%rowtype;
  v_probe_fresh boolean := false;
  v_group_reason text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ivrm-cloud-monitor',0));

  -- Pre-pass: is this a full ingest outage?
  select count(*),
         count(*) filter (
           where clock_timestamp() - coalesce(received_at, created_at) > make_interval(secs => stale_after_seconds)
         )
    into v_total, v_stale_total
  from public.cloud_monitor_targets
  where enabled;
  v_outage := v_total >= 2 and v_stale_total = v_total;

  select * into v_probe from public.console_ingest_health where id = 1;
  v_probe_fresh := found and v_probe.checked_at > clock_timestamp() - interval '10 minutes';

  if v_outage then
    -- One grouped announcement replaces the per-target ones; drop any
    -- per-target deliveries that have not gone out yet.
    update public.notification_outbox
    set status = 'suppressed',
        suppression_reason = 'cloud_ingest_outage_grouped',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where signal_key like 'cloud:state:%'
      and status in ('pending', 'retry', 'sending');

    if v_probe_fresh and v_probe.deployment_disabled then
      v_group_reason := 'collector_ingest_outage: 全Cloud Monitor対象（' || v_total
        || '件）の収集が停止しています。Console（console.ivrm.jp）が HTTP '
        || v_probe.http_status
        || ' DEPLOYMENT_DISABLED を返しており、Vercel の無料枠（Hobby fair use）超過による一時停止を検知しました。対象サービスの障害ではなく、監視収集基盤の停止です。';
    else
      v_group_reason := 'collector_ingest_outage: 全Cloud Monitor対象（' || v_total
        || '件）の収集が停止しています。Console の無効化は検知されておらず、原因は未特定です。対象サービスの障害ではなく、監視収集基盤の停止です。';
    end if;
  else
    v_group_reason := 'collector_ingest_outage: Cloud Monitor の収集が再開しました。';
  end if;

  perform public.apply_cloud_monitor_signal_v2(
    'cloud:ingest-outage', 'cloud', null, 'ivrm', 'cloud', 'cloud-ingest',
    'Cloud Monitor 全体収集', 'cloud_ingest_outage',
    v_outage, 'critical', clock_timestamp(), v_group_reason,
    'Cloud Monitor 全体収集 / Cloud Monitor', '/cloud', true);

  for t in select * from public.cloud_monitor_targets order by id for update loop
    v_key := 'cloud:state:' || t.id;
    if not t.enabled then
      -- Retiring a target must not emit a misleading recovery.
      update public.notification_signal_state set active=false,
        recovered_at=greatest(opened_at,clock_timestamp()), updated_at=clock_timestamp()
        where signal_key=v_key and active;
      update public.notification_outbox set status='suppressed', suppression_reason='cloud_target_disabled',
        claim_token=null, claimed_at=null, updated_at=clock_timestamp()
        where signal_key=v_key and status in ('pending','retry','sending');
      continue;
    end if;
    v_stale := clock_timestamp() - coalesce(t.received_at,t.created_at) > make_interval(secs=>t.stale_after_seconds);
    if t.received_at is null and not v_stale then continue; end if;
    perform public.apply_cloud_monitor_signal_v2(
      v_key, 'cloud', null, 'ivrm', 'cloud', t.id, t.display_name, 'cloud_state',
      v_stale or t.status <> 'operational',
      case when v_stale or t.status='outage' then 'critical' else 'warning' end,
      clock_timestamp(),
      case when v_stale then 'collector_stale' else t.status || ':' || t.reason_code end,
      t.display_name || ' / Cloud Monitor', '/cloud',
      not v_outage);
    v_count := v_count+1;
  end loop;
  return v_count;
end; $$;
