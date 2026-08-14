-- Reliability v2 Phase 3: Multi-window SLO Burn Rate alerting.
-- Existing Host / Container / Backup notification functions remain unchanged.

alter table public.notification_signal_state
  alter column host_id drop not null;
alter table public.notification_outbox
  alter column host_id drop not null;

alter table public.notification_signal_state
  drop constraint if exists notification_signal_source_check;
alter table public.notification_signal_state
  add constraint notification_signal_source_check
  check (source_type in ('host', 'container', 'backup', 'reliability'));

alter table public.notification_signal_state
  drop constraint if exists notification_signal_entity_type_check;
alter table public.notification_signal_state
  add constraint notification_signal_entity_type_check
  check (entity_type in ('host', 'container', 'backup', 'reliability'));

alter table public.notification_signal_state
  drop constraint if exists notification_signal_reliability_shape_check;
alter table public.notification_signal_state
  add constraint notification_signal_reliability_shape_check
  check (
    (
      source_type = 'reliability'
      and entity_type = 'reliability'
      and host_id is null
      and server_id = 'ivrm'
    )
    or (
      source_type in ('host', 'container', 'backup')
      and entity_type in ('host', 'container', 'backup')
      and host_id is not null
    )
  );

alter table public.notification_outbox
  drop constraint if exists notification_outbox_source_check;
alter table public.notification_outbox
  add constraint notification_outbox_source_check
  check (source_type in ('host', 'container', 'backup', 'reliability'));

alter table public.notification_outbox
  drop constraint if exists notification_outbox_entity_type_check;
alter table public.notification_outbox
  add constraint notification_outbox_entity_type_check
  check (entity_type in ('host', 'container', 'backup', 'reliability'));

alter table public.notification_outbox
  drop constraint if exists notification_outbox_reliability_shape_check;
alter table public.notification_outbox
  add constraint notification_outbox_reliability_shape_check
  check (
    (
      source_type = 'reliability'
      and entity_type = 'reliability'
      and host_id is null
      and server_id = 'ivrm'
    )
    or (
      source_type in ('host', 'container', 'backup')
      and entity_type in ('host', 'container', 'backup')
      and host_id is not null
    )
  );

alter table public.notification_suppressions
  drop constraint if exists notification_suppressions_scope_check;
alter table public.notification_suppressions
  add constraint notification_suppressions_scope_check
  check (scope_type in ('global', 'host', 'container', 'backup', 'reliability', 'signal'));

create table public.reliability_burn_reconcile_credentials (
  id smallint primary key default 1,
  token_sha256 text not null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint reliability_burn_reconcile_credentials_singleton_check check (id = 1),
  constraint reliability_burn_reconcile_credentials_hash_check
    check (token_sha256 ~ '^[a-f0-9]{64}$')
);

create table public.reliability_burn_reconcile_state (
  id smallint primary key default 1,
  enabled boolean not null default false,
  endpoint_url text,
  last_invoked_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_evaluated_count integer not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  constraint reliability_burn_reconcile_state_singleton_check check (id = 1),
  constraint reliability_burn_reconcile_state_endpoint_check check (
    endpoint_url is null
    or endpoint_url = 'https://console.ivrm.jp/api/reliability/burn-reconcile'
  ),
  constraint reliability_burn_reconcile_state_error_check check (
    last_error_code is null or char_length(last_error_code) <= 128
  ),
  constraint reliability_burn_reconcile_state_count_check check (
    last_evaluated_count between 0 and 4
  )
);

insert into public.reliability_burn_reconcile_state (id)
values (1)
on conflict (id) do nothing;

alter table public.reliability_burn_reconcile_credentials enable row level security;
alter table public.reliability_burn_reconcile_credentials force row level security;
alter table public.reliability_burn_reconcile_state enable row level security;
alter table public.reliability_burn_reconcile_state force row level security;

revoke all on table public.reliability_burn_reconcile_credentials
  from public, anon, authenticated, service_role;
revoke all on table public.reliability_burn_reconcile_state
  from public, anon, authenticated, service_role;
grant select on table public.reliability_burn_reconcile_state to service_role;

-- 平文TokenはVaultだけへ保存し、通常TableにはSHA-256だけを保持する。
do $$
declare
  v_token text;
  v_hash text;
begin
  select secrets.decrypted_secret
  into v_token
  from vault.decrypted_secrets as secrets
  where secrets.name = 'ivrm_reliability_burn_reconcile_token'
  order by secrets.updated_at desc
  limit 1;

  if v_token is null then
    v_token := encode(extensions.gen_random_bytes(48), 'hex');
    perform vault.create_secret(
      v_token,
      'ivrm_reliability_burn_reconcile_token',
      'IVRM Reliability Burn Rate reconciler token',
      null
    );
  end if;

  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into public.reliability_burn_reconcile_credentials (id, token_sha256)
  values (1, v_hash)
  on conflict (id) do update
  set token_sha256 = excluded.token_sha256,
      updated_at = clock_timestamp();
end;
$$;

create or replace function public.verify_reliability_burn_reconcile_token_v1(
  p_token_sha256 text
)
returns boolean
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select coalesce((
    select credentials.token_sha256 = p_token_sha256
    from public.reliability_burn_reconcile_credentials as credentials
    where credentials.id = 1
      and p_token_sha256 ~ '^[a-f0-9]{64}$'
  ), false);
$$;

create or replace function public.enqueue_reliability_notification_v1(
  p_dedupe_key text,
  p_signal_key text,
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
    or p_signal_key is null or char_length(p_signal_key) not between 1 and 500
    or p_entity_key not in ('overall', 'host', 'container', 'backup')
    or p_entity_name is null or char_length(p_entity_name) not between 1 and 256
    or p_transition not in ('opened', 'escalated', 'recovered')
    or p_severity not in ('warning', 'critical', 'recovery')
    or p_title is null or char_length(p_title) not between 1 and 160
    or p_message is null or char_length(p_message) not between 1 and 1800
    or p_detail_href is null
    or char_length(p_detail_href) > 1001
    or p_detail_href !~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
    or p_occurred_at is null then
    raise exception 'reliability_notification_payload_invalid' using errcode = '22023';
  end if;

  v_suppression_reason := public.notification_suppression_reason_v1(
    null,
    'reliability',
    p_entity_key,
    p_entity_name,
    p_signal_key,
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
    'reliability',
    null,
    'ivrm',
    'reliability',
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

create or replace function public.apply_reliability_burn_signal_v1(
  p_service_id text,
  p_active boolean,
  p_severity text,
  p_occurred_at timestamptz,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_signal_key text;
  v_entity_name text;
  v_title text;
  v_detail_href text := '/reliability?range=24h#burn-rate';
  v_current public.notification_signal_state%rowtype;
  v_transition text;
  v_delivery_severity text;
  v_dedupe_key text;
begin
  if p_service_id not in ('overall', 'host', 'container', 'backup')
    or p_active is null
    or p_severity not in ('warning', 'critical')
    or p_occurred_at is null
    or p_reason is null or char_length(p_reason) not between 1 and 1800 then
    raise exception 'reliability_burn_signal_invalid' using errcode = '22023';
  end if;

  v_entity_name := case p_service_id
    when 'overall' then 'Overall Reliability'
    when 'host' then 'Host Platform'
    when 'container' then 'Container Runtime'
    when 'backup' then 'Backup Protection'
  end;
  v_signal_key := 'reliability:slo_burn_rate:' || p_service_id;
  v_title := v_entity_name || ' / SLO Burn Rate';

  perform pg_advisory_xact_lock(hashtextextended(v_signal_key, 0));

  select * into v_current
  from public.notification_signal_state
  where signal_key = v_signal_key
  for update;

  if found and p_occurred_at < v_current.last_seen_at then
    return 'stale_ignored';
  end if;

  if p_active then
    if not found then
      insert into public.notification_signal_state (
        signal_key,
        source_type,
        host_id,
        server_id,
        entity_type,
        entity_key,
        entity_name,
        signal_type,
        severity,
        active,
        opened_at,
        last_seen_at,
        recovered_at,
        reason,
        detail_href
      ) values (
        v_signal_key,
        'reliability',
        null,
        'ivrm',
        'reliability',
        p_service_id,
        v_entity_name,
        'slo_burn_rate',
        p_severity,
        true,
        p_occurred_at,
        p_occurred_at,
        null,
        p_reason,
        v_detail_href
      );
      v_transition := 'opened';
    elsif not v_current.active then
      update public.notification_signal_state
      set severity = p_severity,
          active = true,
          opened_at = p_occurred_at,
          last_seen_at = p_occurred_at,
          recovered_at = null,
          reason = p_reason,
          detail_href = v_detail_href,
          updated_at = clock_timestamp()
      where signal_key = v_signal_key;
      v_transition := 'opened';
    elsif public.notification_severity_rank_v1(p_severity)
          > public.notification_severity_rank_v1(v_current.severity) then
      update public.notification_signal_state
      set severity = p_severity,
          last_seen_at = p_occurred_at,
          reason = p_reason,
          detail_href = v_detail_href,
          updated_at = clock_timestamp()
      where signal_key = v_signal_key;
      v_transition := 'escalated';
    else
      if public.notification_severity_rank_v1(p_severity)
         < public.notification_severity_rank_v1(v_current.severity) then
        -- Criticalが配送前にWarningへ下がった場合、古いCriticalを後追い配送しない。
        update public.notification_outbox
        set status = 'suppressed',
            suppression_reason = 'signal_deescalated_before_delivery',
            claim_token = null,
            claimed_at = null,
            updated_at = clock_timestamp()
        where signal_key = v_signal_key
          and severity = 'critical'
          and occurred_at >= v_current.opened_at
          and status in ('pending', 'retry', 'sending');

        update public.notification_signal_state
        set severity = p_severity,
            last_seen_at = p_occurred_at,
            reason = p_reason,
            detail_href = v_detail_href,
            updated_at = clock_timestamp()
        where signal_key = v_signal_key;
        return 'deescalated';
      end if;

      update public.notification_signal_state
      set last_seen_at = p_occurred_at,
          reason = p_reason,
          detail_href = v_detail_href,
          updated_at = clock_timestamp()
      where signal_key = v_signal_key;
      return 'unchanged';
    end if;

    v_delivery_severity := p_severity;
    if v_transition = 'escalated' then
      v_title := '重大化: ' || v_title;
    end if;
  else
    if not found or not v_current.active then
      return 'unchanged';
    end if;

    update public.notification_outbox
    set status = 'suppressed',
        suppression_reason = 'signal_recovered_before_delivery',
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where signal_key = v_signal_key
      and transition in ('opened', 'escalated')
      and occurred_at >= v_current.opened_at
      and status in ('pending', 'retry', 'sending');

    update public.notification_signal_state
    set active = false,
        last_seen_at = p_occurred_at,
        recovered_at = greatest(opened_at, p_occurred_at),
        reason = p_reason,
        detail_href = v_detail_href,
        updated_at = clock_timestamp()
    where signal_key = v_signal_key;

    v_transition := 'recovered';
    v_delivery_severity := 'recovery';
    v_title := '復旧: ' || v_title;
  end if;

  v_dedupe_key := v_signal_key || ':' || v_transition || ':'
    || to_char(p_occurred_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS');

  perform public.enqueue_reliability_notification_v1(
    v_dedupe_key,
    v_signal_key,
    p_service_id,
    v_entity_name,
    v_transition,
    v_delivery_severity,
    v_title,
    p_reason,
    v_detail_href,
    p_occurred_at
  );

  return v_transition;
end;
$$;

create or replace function public.mark_reliability_burn_reconcile_v1(
  p_success boolean,
  p_evaluated_count integer,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_success is null
    or p_evaluated_count is null or p_evaluated_count < 0 or p_evaluated_count > 4
    or (p_error_code is not null and char_length(p_error_code) > 128) then
    raise exception 'reliability_burn_reconcile_state_invalid' using errcode = '22023';
  end if;

  update public.reliability_burn_reconcile_state
  set last_invoked_at = clock_timestamp(),
      last_success_at = case when p_success then clock_timestamp() else last_success_at end,
      last_error_at = case when p_success then null else clock_timestamp() end,
      last_error_code = case when p_success then null else coalesce(p_error_code, 'unknown_error') end,
      last_evaluated_count = p_evaluated_count,
      updated_at = clock_timestamp()
  where id = 1;
end;
$$;

create or replace function public.get_reliability_burn_reconcile_state_v1()
returns table (
  enabled boolean,
  endpoint_configured boolean,
  last_invoked_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_evaluated_count integer
)
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select
    state.enabled,
    state.endpoint_url is not null,
    state.last_invoked_at,
    state.last_success_at,
    state.last_error_at,
    state.last_error_code,
    state.last_evaluated_count
  from public.reliability_burn_reconcile_state as state
  where state.id = 1;
$$;

create or replace function public.kick_reliability_burn_reconcile_v1()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net
as $$
declare
  v_state public.reliability_burn_reconcile_state%rowtype;
  v_token text;
  v_request_id bigint;
begin
  select * into v_state
  from public.reliability_burn_reconcile_state
  where id = 1;

  if not found or not v_state.enabled then
    return null;
  end if;

  if v_state.endpoint_url is null
     or v_state.endpoint_url <> 'https://console.ivrm.jp/api/reliability/burn-reconcile' then
    update public.reliability_burn_reconcile_state
    set last_invoked_at = clock_timestamp(),
        last_error_at = clock_timestamp(),
        last_error_code = 'endpoint_unconfigured',
        updated_at = clock_timestamp()
    where id = 1;
    return null;
  end if;

  select secrets.decrypted_secret
  into v_token
  from vault.decrypted_secrets as secrets
  where secrets.name = 'ivrm_reliability_burn_reconcile_token'
  order by secrets.updated_at desc
  limit 1;

  if v_token is null or char_length(v_token) < 32 or char_length(v_token) > 256 then
    update public.reliability_burn_reconcile_state
    set last_invoked_at = clock_timestamp(),
        last_error_at = clock_timestamp(),
        last_error_code = 'scheduler_token_missing',
        updated_at = clock_timestamp()
    where id = 1;
    return null;
  end if;

  update public.reliability_burn_reconcile_state
  set last_invoked_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = 1;

  select net.http_post(
    url := v_state.endpoint_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ivrm-reliability-token', v_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) into v_request_id;

  return v_request_id;
end;
$$;

create or replace function public.set_reliability_burn_reconciler_v1(
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, cron
as $$
declare
  v_job_id bigint;
begin
  if p_enabled is null then
    raise exception 'reliability_burn_reconciler_enabled_required' using errcode = '22023';
  end if;

  for v_job_id in
    select jobs.jobid
    from cron.job as jobs
    where jobs.jobname = 'ivrm-reliability-burn-reconcile'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  if p_enabled then
    update public.reliability_burn_reconcile_state
    set enabled = true,
        endpoint_url = 'https://console.ivrm.jp/api/reliability/burn-reconcile',
        last_error_at = null,
        last_error_code = null,
        updated_at = clock_timestamp()
    where id = 1;

    perform cron.schedule(
      'ivrm-reliability-burn-reconcile',
      '* * * * *',
      'select public.kick_reliability_burn_reconcile_v1();'
    );
  else
    update public.reliability_burn_reconcile_state
    set enabled = false,
        endpoint_url = null,
        updated_at = clock_timestamp()
    where id = 1;
  end if;
end;
$$;

revoke all on function public.verify_reliability_burn_reconcile_token_v1(text)
  from public, anon, authenticated;
grant execute on function public.verify_reliability_burn_reconcile_token_v1(text)
  to service_role;

revoke all on function public.enqueue_reliability_notification_v1(
  text, text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;

revoke all on function public.apply_reliability_burn_signal_v1(
  text, boolean, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.apply_reliability_burn_signal_v1(
  text, boolean, text, timestamptz, text
) to service_role;

revoke all on function public.mark_reliability_burn_reconcile_v1(
  boolean, integer, text
) from public, anon, authenticated;
grant execute on function public.mark_reliability_burn_reconcile_v1(
  boolean, integer, text
) to service_role;

revoke all on function public.get_reliability_burn_reconcile_state_v1()
  from public, anon, authenticated;
grant execute on function public.get_reliability_burn_reconcile_state_v1()
  to service_role;

revoke all on function public.kick_reliability_burn_reconcile_v1()
  from public, anon, authenticated;
grant execute on function public.kick_reliability_burn_reconcile_v1()
  to service_role;

revoke all on function public.set_reliability_burn_reconciler_v1(boolean)
  from public, anon, authenticated;
grant execute on function public.set_reliability_burn_reconciler_v1(boolean)
  to service_role;

comment on table public.reliability_burn_reconcile_credentials is
  'SHA-256 credential for the Reliability Burn Rate reconciler. Plaintext token is stored only in Supabase Vault.';
comment on table public.reliability_burn_reconcile_state is
  'Operational state for the one-minute Reliability Burn Rate reconciler. Disabled by default until Production app deployment is complete.';
comment on function public.apply_reliability_burn_signal_v1(text, boolean, text, timestamptz, text) is
  'Applies durable Reliability SLO Burn Rate signal lifecycle without changing existing Host/Container/Backup notification functions. Severity downgrade is silent; recovery remains durable.';
comment on function public.set_reliability_burn_reconciler_v1(boolean) is
  'Enables or disables the Production one-minute Burn Rate reconcile cron. Migration does not enable it automatically.';
