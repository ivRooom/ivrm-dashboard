-- Local, disposable PostgreSQL only. Loads the real notification table contracts.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end; $$;
create table public.hosts(id uuid primary key default gen_random_uuid(), server_id text unique not null, enabled boolean not null default true);
create table public.container_expectations(host_id uuid, container_name text, maintenance_mode boolean, maintenance_until timestamptz);
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
update public.notification_channels set enabled=true,configured=true where id=1;

alter table public.notification_signal_state
  drop constraint if exists notification_signal_href_check;
alter table public.notification_signal_state
  add constraint notification_signal_href_check
  check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/[A-Za-z0-9_./?=&%:+#-]*$'
  );

alter table public.notification_outbox
  drop constraint if exists notification_outbox_href_check;
alter table public.notification_outbox
  add constraint notification_outbox_href_check
  check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/[A-Za-z0-9_./?=&%:+#-]*$'
  );
