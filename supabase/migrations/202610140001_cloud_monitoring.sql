-- Issue #120. No scheduler is activated by this migration.
alter table public.notification_signal_state drop constraint notification_signal_source_check;
alter table public.notification_signal_state add constraint notification_signal_source_check check (source_type in ('host','container','backup','reliability','cloud'));
alter table public.notification_signal_state drop constraint notification_signal_entity_type_check;
alter table public.notification_signal_state add constraint notification_signal_entity_type_check check (entity_type in ('host','container','backup','reliability','cloud'));
alter table public.notification_signal_state drop constraint notification_signal_reliability_shape_check;
alter table public.notification_signal_state add constraint notification_signal_reliability_shape_check check ((source_type in ('reliability','cloud') and entity_type=source_type and host_id is null and server_id='ivrm') or (source_type in ('host','container','backup') and entity_type in ('host','container','backup') and host_id is not null));
alter table public.notification_outbox drop constraint notification_outbox_source_check;
alter table public.notification_outbox add constraint notification_outbox_source_check check (source_type in ('host','container','backup','reliability','cloud'));
alter table public.notification_outbox drop constraint notification_outbox_entity_type_check;
alter table public.notification_outbox add constraint notification_outbox_entity_type_check check (entity_type in ('host','container','backup','reliability','cloud'));
alter table public.notification_outbox drop constraint notification_outbox_reliability_shape_check;
alter table public.notification_outbox add constraint notification_outbox_reliability_shape_check check ((source_type in ('reliability','cloud') and entity_type=source_type and host_id is null and server_id='ivrm') or (source_type in ('host','container','backup') and entity_type in ('host','container','backup') and host_id is not null));
alter table public.notification_suppressions drop constraint notification_suppressions_scope_check;
alter table public.notification_suppressions add constraint notification_suppressions_scope_check check (scope_type in ('global','host','container','backup','reliability','cloud','signal'));

create or replace function public.enqueue_cloud_notification_v1(
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
    or p_source_type not in ('cloud')
    or p_host_id is not null
    or p_server_id is distinct from 'ivrm'
    or p_entity_type not in ('cloud')
    or p_entity_key is null or char_length(p_entity_key) not between 1 and 400
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_transition not in ('opened', 'escalated', 'recovered', 'event')
    or p_severity not in ('info', 'warning', 'critical', 'recovery')
    or p_title is null or char_length(p_title) not between 1 and 160
    or p_message is null or char_length(p_message) not between 1 and 1800
    or p_detail_href is null or p_detail_href <> '/cloud'
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
declare
  v_current public.notification_signal_state%rowtype;
  v_transition text;
  v_dedupe_key text;
  v_delivery_severity text;
  v_title text;
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

create table public.cloud_monitor_targets (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  provider text not null check (provider in ('aws','lightsail','oci','vercel','netlify','cloudflare','http')),
  display_name text not null check (char_length(display_name) between 1 and 120),
  collector_server_id text not null references public.hosts(server_id),
  enabled boolean not null default false,
  stale_after_seconds integer not null default 900 check (stale_after_seconds between 120 and 86400),
  status text not null default 'unknown' check (status in ('operational','degraded','outage','unknown','error')),
  reason_code text not null default 'not_received' check (reason_code in ('ok','not_received','not_configured','auth_error','forbidden','timeout','provider_error','not_found','unexpected_state','dns_mismatch')),
  observed_at timestamptz,
  received_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);
create table public.cloud_monitor_requests (
  collector_server_id text not null references public.hosts(server_id),
  nonce text not null check (nonce ~ '^[a-f0-9]{32}$'),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz not null default clock_timestamp(),
  primary key (collector_server_id, nonce)
);
create index cloud_monitor_requests_retention on public.cloud_monitor_requests(received_at);
create table public.cloud_monitor_samples (
  id bigint generated always as identity primary key,
  target_id text not null references public.cloud_monitor_targets(id) on delete cascade,
  status text not null check (status in ('operational','degraded','outage','unknown','error')),
  reason_code text not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp()
);
create index cloud_monitor_samples_target_time on public.cloud_monitor_samples(target_id, observed_at desc);
create index cloud_monitor_samples_retention on public.cloud_monitor_samples(received_at);
alter table public.cloud_monitor_targets enable row level security;
alter table public.cloud_monitor_requests enable row level security;
alter table public.cloud_monitor_samples enable row level security;
revoke all on public.cloud_monitor_targets, public.cloud_monitor_requests, public.cloud_monitor_samples from public, anon, authenticated;
grant select on public.cloud_monitor_targets, public.cloud_monitor_samples to service_role;

create or replace function public.reconcile_cloud_monitor_signals_v1()
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare t public.cloud_monitor_targets%rowtype; v_stale boolean; v_count integer := 0; v_key text;
begin
  perform pg_advisory_xact_lock(hashtextextended('ivrm-cloud-monitor',0));
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
    perform public.apply_cloud_monitor_signal_v1(
      v_key, 'cloud', null, 'ivrm', 'cloud', t.id, t.display_name, 'cloud_state',
      v_stale or t.status <> 'operational',
      case when v_stale or t.status='outage' then 'critical' else 'warning' end,
      clock_timestamp(),
      case when v_stale then 'collector_stale' else t.status || ':' || t.reason_code end,
      t.display_name || ' / Cloud Monitor', '/cloud');
    v_count := v_count+1;
  end loop;
  return v_count;
end; $$;

create or replace function public.ingest_cloud_monitor_v1(
  p_server_id text, p_nonce text, p_body_sha256 text, p_observed_at timestamptz, p_results jsonb
) returns text language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_host public.hosts%rowtype; r jsonb; t public.cloud_monitor_targets%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('ivrm-cloud-monitor',0));
  select * into v_host from public.hosts where server_id=p_server_id and enabled for update;
  if not found then return 'unknown_agent'; end if;
  if p_nonce is null or p_nonce !~ '^[a-f0-9]{32}$' or p_body_sha256 is null
    or p_body_sha256 !~ '^[a-f0-9]{64}$' or p_observed_at is null
    or abs(extract(epoch from clock_timestamp()-p_observed_at))>300
    or p_observed_at > clock_timestamp()+interval '30 seconds'
    or p_results is null or jsonb_typeof(p_results)<>'array' then return 'invalid_payload'; end if;
  if jsonb_array_length(p_results) not between 1 and 50 then return 'invalid_payload'; end if;
  if exists(select 1 from public.cloud_monitor_requests where collector_server_id=p_server_id and nonce=p_nonce)
    then return 'replayed_request'; end if;
  if exists(select 1 from public.cloud_monitor_requests where collector_server_id=p_server_id
    and received_at>clock_timestamp()-interval '15 seconds') then return 'rate_limited'; end if;
  if (select count(distinct value->>'id') from jsonb_array_elements(p_results))<>jsonb_array_length(p_results)
    then return 'invalid_payload'; end if;
  -- Validate the entire batch before accepting its nonce or updating any target.
  for r in select value from jsonb_array_elements(p_results) loop
    if jsonb_typeof(r)<>'object' or not (r ?& array['id','status','reasonCode'])
      or r - array['id','status','reasonCode'] <> '{}'::jsonb
      or coalesce(r->>'status','') not in ('operational','degraded','outage','unknown','error')
      or coalesce(r->>'reasonCode','') not in ('ok','not_configured','auth_error','forbidden','timeout','provider_error','not_found','unexpected_state','dns_mismatch')
      or (r->>'status'='operational' and r->>'reasonCode'<>'ok') then return 'invalid_payload'; end if;
    select * into t from public.cloud_monitor_targets where id=r->>'id' and collector_server_id=p_server_id;
    if not found then return 'target_not_allowed'; end if;
  end loop;
  insert into public.cloud_monitor_requests(collector_server_id,nonce,body_sha256) values(p_server_id,p_nonce,p_body_sha256);
  for r in select value from jsonb_array_elements(p_results) loop
    update public.cloud_monitor_targets set status=r->>'status',reason_code=r->>'reasonCode',
      observed_at=p_observed_at,received_at=clock_timestamp()
      where id=r->>'id' and enabled and (observed_at is null or observed_at<p_observed_at);
    if found then
      insert into public.cloud_monitor_samples(target_id,status,reason_code,observed_at)
        values(r->>'id',r->>'status',r->>'reasonCode',p_observed_at);
    end if;
  end loop;
  perform public.reconcile_cloud_monitor_signals_v1();
  return 'accepted';
end; $$;

create or replace function public.prune_cloud_monitor_history_v1()
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  delete from public.cloud_monitor_samples where received_at<clock_timestamp()-interval '7 days';
  delete from public.cloud_monitor_requests where received_at<clock_timestamp()-interval '1 day';
end; $$;

revoke all on function public.enqueue_cloud_notification_v1(text,text,text,uuid,text,text,text,text,text,text,text,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.apply_cloud_monitor_signal_v1(text,text,uuid,text,text,text,text,text,boolean,text,timestamptz,text,text,text) from public, anon, authenticated;
revoke all on function public.ingest_cloud_monitor_v1(text,text,text,timestamptz,jsonb) from public, anon, authenticated;
revoke all on function public.reconcile_cloud_monitor_signals_v1() from public, anon, authenticated;
revoke all on function public.prune_cloud_monitor_history_v1() from public, anon, authenticated;
grant execute on function public.ingest_cloud_monitor_v1(text,text,text,timestamptz,jsonb) to service_role;
grant execute on function public.reconcile_cloud_monitor_signals_v1(), public.prune_cloud_monitor_history_v1() to service_role;
