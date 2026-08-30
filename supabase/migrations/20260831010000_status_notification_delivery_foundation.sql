-- Status lifecycle logical events + per-channel delivery foundation.
-- Existing monitoring notification_outbox remains unchanged.

-- Widen the existing Discord singleton channel registry so future providers can be
-- represented without changing the delivery schema. Existing monitoring RPCs
-- intentionally continue to target Discord channel id=1.
alter table public.notification_channels
  drop constraint if exists notification_channels_singleton_check;
alter table public.notification_channels
  drop constraint if exists notification_channels_type_check;
alter table public.notification_channels
  drop constraint if exists notification_channels_id_check;
alter table public.notification_channels
  add constraint notification_channels_id_check check (id between 1 and 32767),
  add constraint notification_channels_type_check check (channel_type in ('discord', 'slack')),
  add constraint notification_channels_legacy_discord_check check (id <> 1 or channel_type = 'discord');

create or replace function public.prevent_notification_channel_identity_change_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id or new.channel_type is distinct from old.channel_type then
    raise exception 'notification_channel_identity_is_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_notification_channel_identity_change_v1()
  from public, anon, authenticated, service_role;

create trigger notification_channels_identity_immutable
before update of id, channel_type on public.notification_channels
for each row execute function public.prevent_notification_channel_identity_change_v1();

create table public.notification_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  event_type text not null,
  source_type text not null,
  source_public_id text not null,
  title text not null,
  message text not null,
  detail_href text not null,
  severity text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint notification_events_key_check check (
    char_length(event_key) between 1 and 256
    and event_key ~ '^[A-Za-z0-9:_-]+$'
  ),
  constraint notification_events_type_check check (event_type in (
    'incident_published',
    'incident_update_published',
    'incident_resolved',
    'maintenance_published',
    'maintenance_cancelled',
    'announcement_published'
  )),
  constraint notification_events_source_check check (source_type in (
    'incident', 'maintenance', 'announcement'
  )),
  constraint notification_events_public_id_check check (
    (source_type = 'incident' and source_public_id ~ '^INC-[A-F0-9]{12}$')
    or (source_type = 'maintenance' and source_public_id ~ '^MNT-[A-F0-9]{12}$')
    or (source_type = 'announcement' and source_public_id ~ '^ANN-[A-F0-9]{12}$')
  ),
  constraint notification_events_title_check check (
    char_length(title) between 1 and 160 and title = btrim(title)
  ),
  constraint notification_events_message_check check (
    char_length(message) between 1 and 4000 and message = btrim(message)
  ),
  constraint notification_events_href_check check (
    char_length(detail_href) between 1 and 1001
    and detail_href ~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
  ),
  constraint notification_events_severity_check check (severity in ('info', 'warning', 'critical'))
);

create table public.notification_deliveries (
  id bigint generated always as identity primary key,
  event_id bigint not null references public.notification_events(id) on delete restrict,
  channel_id smallint not null references public.notification_channels(id) on delete restrict,
  provider_type text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_token uuid,
  claimed_at timestamptz,
  sent_at timestamptz,
  last_http_status integer,
  external_delivery_id text,
  last_error_code text,
  suppression_reason text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint notification_deliveries_event_channel_key unique (event_id, channel_id),
  constraint notification_deliveries_provider_check check (provider_type in ('discord', 'slack')),
  constraint notification_deliveries_status_check check (
    status in ('pending', 'sending', 'sent', 'retry', 'failed', 'suppressed')
  ),
  constraint notification_deliveries_attempts_check check (attempts between 0 and 20),
  constraint notification_deliveries_claim_check check (
    (status = 'sending' and claim_token is not null and claimed_at is not null)
    or (status <> 'sending' and claim_token is null and claimed_at is null)
  ),
  constraint notification_deliveries_sent_check check (
    (status = 'sent' and sent_at is not null)
    or (status <> 'sent' and sent_at is null)
  ),
  constraint notification_deliveries_http_check check (
    last_http_status is null or last_http_status between 100 and 599
  ),
  constraint notification_deliveries_external_id_check check (
    external_delivery_id is null or char_length(external_delivery_id) <= 128
  ),
  constraint notification_deliveries_error_code_check check (
    last_error_code is null or char_length(last_error_code) <= 128
  ),
  constraint notification_deliveries_suppression_check check (
    (status = 'suppressed' and suppression_reason is not null and char_length(suppression_reason) between 1 and 256)
    or (status <> 'suppressed' and suppression_reason is null)
  )
);

create index notification_events_source_idx
  on public.notification_events (source_type, source_public_id, occurred_at desc, id desc);
create index notification_events_occurred_idx
  on public.notification_events (occurred_at desc, id desc);
create index notification_deliveries_channel_idx
  on public.notification_deliveries (channel_id, created_at desc, id desc);
create index notification_deliveries_claim_idx
  on public.notification_deliveries (provider_type, status, next_attempt_at, id)
  where status in ('pending', 'retry', 'sending');

alter table public.notification_events enable row level security;
alter table public.notification_events force row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_deliveries force row level security;

revoke all on table public.notification_events from public, anon, authenticated, service_role;
revoke all on table public.notification_deliveries from public, anon, authenticated, service_role;

create or replace function public.prevent_notification_event_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'notification_events_are_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.prevent_notification_event_mutation_v1()
  from public, anon, authenticated, service_role;

create trigger notification_events_immutable
before update or delete on public.notification_events
for each row execute function public.prevent_notification_event_mutation_v1();

create or replace function public.notification_status_suppression_reason_v1(
  p_at timestamptz
)
returns text
language sql
security definer
set search_path = pg_catalog, public
stable
as $$
  select case when exists (
    select 1
    from public.notification_suppressions as suppressions
    where suppressions.enabled
      and suppressions.scope_type = 'global'
      and suppressions.scope_key = '*'
      and suppressions.starts_at <= p_at
      and (suppressions.ends_at is null or suppressions.ends_at > p_at)
  ) then 'global_suppression' else null end;
$$;

revoke all on function public.notification_status_suppression_reason_v1(timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.create_status_notification_event_v1(
  p_event_key text,
  p_event_type text,
  p_source_type text,
  p_source_public_id text,
  p_title text,
  p_message text,
  p_detail_href text,
  p_severity text,
  p_occurred_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event public.notification_events%rowtype;
  v_suppression_reason text;
begin
  if p_event_key is null
    or char_length(p_event_key) not between 1 and 256
    or p_event_key !~ '^[A-Za-z0-9:_-]+$'
    or p_event_type is null or p_event_type not in (
      'incident_published',
      'incident_update_published',
      'incident_resolved',
      'maintenance_published',
      'maintenance_cancelled',
      'announcement_published'
    )
    or p_source_type is null or p_source_type not in ('incident', 'maintenance', 'announcement')
    or p_source_public_id is null
    or not (
      (p_source_type = 'incident' and p_source_public_id ~ '^INC-[A-F0-9]{12}$')
      or (p_source_type = 'maintenance' and p_source_public_id ~ '^MNT-[A-F0-9]{12}$')
      or (p_source_type = 'announcement' and p_source_public_id ~ '^ANN-[A-F0-9]{12}$')
    )
    or p_title is null or char_length(p_title) not between 1 and 160 or p_title <> btrim(p_title)
    or p_message is null or char_length(p_message) not between 1 and 4000 or p_message <> btrim(p_message)
    or p_detail_href is null or char_length(p_detail_href) not between 1 and 1001
    or p_detail_href !~ '^/(?!/)[A-Za-z0-9_./?=&%:+#-]*$'
    or p_severity is null or p_severity not in ('info', 'warning', 'critical')
    or p_occurred_at is null then
    raise exception 'status_notification_event_invalid' using errcode = '22023';
  end if;

  insert into public.notification_events (
    event_key,
    event_type,
    source_type,
    source_public_id,
    title,
    message,
    detail_href,
    severity,
    occurred_at
  ) values (
    p_event_key,
    p_event_type,
    p_source_type,
    p_source_public_id,
    p_title,
    p_message,
    p_detail_href,
    p_severity,
    p_occurred_at
  )
  on conflict (event_key) do nothing
  returning * into v_event;

  if found then
    v_suppression_reason := public.notification_status_suppression_reason_v1(p_occurred_at);

    insert into public.notification_deliveries (
      event_id,
      channel_id,
      provider_type,
      status,
      next_attempt_at,
      suppression_reason
    )
    select
      v_event.id,
      channels.id,
      channels.channel_type,
      case
        when not channels.enabled then 'suppressed'
        when not channels.configured then 'suppressed'
        when v_suppression_reason is not null then 'suppressed'
        else 'pending'
      end,
      greatest(clock_timestamp(), p_occurred_at),
      case
        when not channels.enabled then 'channel_disabled'
        when not channels.configured then 'channel_unconfigured'
        when v_suppression_reason is not null then v_suppression_reason
        else null
      end
    from public.notification_channels as channels;

    return v_event.id;
  end if;

  select * into v_event
  from public.notification_events as events
  where events.event_key = p_event_key;

  if not found then
    raise exception 'status_notification_event_resolution_failed' using errcode = '40001';
  end if;

  if v_event.event_type is distinct from p_event_type
    or v_event.source_type is distinct from p_source_type
    or v_event.source_public_id is distinct from p_source_public_id
    or v_event.title is distinct from p_title
    or v_event.message is distinct from p_message
    or v_event.detail_href is distinct from p_detail_href
    or v_event.severity is distinct from p_severity
    or v_event.occurred_at is distinct from p_occurred_at then
    raise exception 'status_notification_event_key_conflict' using errcode = '23505';
  end if;

  return v_event.id;
end;
$$;

revoke all on function public.create_status_notification_event_v1(
  text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.status_incident_notification_event_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_incident public.status_incidents%rowtype;
  v_initial boolean;
  v_event_type text;
  v_event_key text;
  v_severity text;
begin
  select * into v_incident
  from public.status_incidents as incidents
  where incidents.id = new.incident_id;

  if not found or v_incident.publication_state <> 'published' then
    raise exception 'status_incident_notification_state_inconsistent' using errcode = '40001';
  end if;

  select not exists (
    select 1
    from public.status_incident_updates as updates
    where updates.incident_id = new.incident_id
      and updates.id <> new.id
  ) into v_initial;

  if v_initial then
    v_event_type := 'incident_published';
    v_event_key := 'status:incident:' || v_incident.public_id || ':published';
  elsif new.lifecycle_status = 'resolved' then
    v_event_type := 'incident_resolved';
    v_event_key := 'status:incident:' || v_incident.public_id || ':resolved';
  else
    v_event_type := 'incident_update_published';
    v_event_key := 'status:incident:' || v_incident.public_id || ':update:' || new.request_id::text;
  end if;

  v_severity := case
    when v_incident.impact = 'critical' then 'critical'
    when v_incident.impact in ('major', 'minor') then 'warning'
    else 'info'
  end;

  perform public.create_status_notification_event_v1(
    v_event_key,
    v_event_type,
    'incident',
    v_incident.public_id,
    v_incident.title,
    new.message,
    '/status-center',
    v_severity,
    new.published_at
  );

  return new;
end;
$$;

revoke all on function public.status_incident_notification_event_trigger_v1()
  from public, anon, authenticated, service_role;

create trigger status_incident_notification_event
  after insert on public.status_incident_updates
  for each row execute function public.status_incident_notification_event_trigger_v1();

create or replace function public.status_maintenance_notification_event_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_event_type text;
  v_event_key text;
  v_severity text;
  v_occurred_at timestamptz;
begin
  if old.publication_state = 'draft' and new.publication_state = 'published' then
    v_event_type := 'maintenance_published';
    v_event_key := 'status:maintenance:' || new.public_id || ':published';
    v_severity := 'info';
    v_occurred_at := new.published_at;
  elsif old.publication_state = 'published' and new.publication_state = 'cancelled' then
    v_event_type := 'maintenance_cancelled';
    v_event_key := 'status:maintenance:' || new.public_id || ':cancelled';
    v_severity := 'warning';
    v_occurred_at := new.cancelled_at;
  else
    return new;
  end if;

  if v_occurred_at is null then
    raise exception 'status_maintenance_notification_timestamp_missing' using errcode = '40001';
  end if;

  perform public.create_status_notification_event_v1(
    v_event_key,
    v_event_type,
    'maintenance',
    new.public_id,
    new.title,
    new.body,
    '/status-center',
    v_severity,
    v_occurred_at
  );

  return new;
end;
$$;

revoke all on function public.status_maintenance_notification_event_trigger_v1()
  from public, anon, authenticated, service_role;

create trigger status_maintenance_notification_event
  after update of publication_state on public.status_maintenance_notices
  for each row execute function public.status_maintenance_notification_event_trigger_v1();

create or replace function public.status_announcement_notification_event_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.publication_state <> 'draft' or new.publication_state <> 'published' then
    return new;
  end if;

  if new.published_at is null then
    raise exception 'status_announcement_notification_timestamp_missing' using errcode = '40001';
  end if;

  perform public.create_status_notification_event_v1(
    'status:announcement:' || new.public_id || ':published',
    'announcement_published',
    'announcement',
    new.public_id,
    new.title,
    new.body,
    '/status-center',
    case when new.kind = 'warning' then 'warning' else 'info' end,
    new.published_at
  );

  return new;
end;
$$;

revoke all on function public.status_announcement_notification_event_trigger_v1()
  from public, anon, authenticated, service_role;

create trigger status_announcement_notification_event
  after update of publication_state on public.status_announcements
  for each row execute function public.status_announcement_notification_event_trigger_v1();

create or replace function public.claim_notification_deliveries_v1(
  p_provider_type text,
  p_claim_token uuid,
  p_limit integer default 10
)
returns table (
  id bigint,
  event_id bigint,
  channel_id smallint,
  provider_type text,
  event_type text,
  source_type text,
  source_public_id text,
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
  if p_provider_type is null or p_provider_type not in ('discord', 'slack')
    or p_claim_token is null
    or p_limit is null or p_limit < 1 or p_limit > 20 then
    raise exception 'notification_delivery_claim_invalid' using errcode = '22023';
  end if;

  update public.notification_deliveries as deliveries
  set status = 'retry',
      claim_token = null,
      claimed_at = null,
      next_attempt_at = clock_timestamp(),
      last_error_code = 'claim_timeout',
      updated_at = clock_timestamp()
  where deliveries.provider_type = p_provider_type
    and deliveries.status = 'sending'
    and deliveries.claimed_at < clock_timestamp() - interval '5 minutes';

  with blocked as (
    select
      deliveries.id,
      case
        when not channels.enabled then 'channel_disabled'
        when not channels.configured then 'channel_unconfigured'
        when public.notification_status_suppression_reason_v1(clock_timestamp()) is not null
          then 'global_suppression'
        else null
      end as reason
    from public.notification_deliveries as deliveries
    join public.notification_channels as channels
      on channels.id = deliveries.channel_id
     and channels.channel_type = deliveries.provider_type
    where deliveries.provider_type = p_provider_type
      and deliveries.status in ('pending', 'retry')
  )
  update public.notification_deliveries as deliveries
  set status = 'suppressed',
      suppression_reason = blocked.reason,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  from blocked
  where deliveries.id = blocked.id
    and blocked.reason is not null;

  return query
  with picked as (
    select deliveries.id
    from public.notification_deliveries as deliveries
    join public.notification_channels as channels
      on channels.id = deliveries.channel_id
     and channels.channel_type = deliveries.provider_type
    join public.notification_events as events
      on events.id = deliveries.event_id
    where deliveries.provider_type = p_provider_type
      and deliveries.status in ('pending', 'retry')
      and deliveries.next_attempt_at <= clock_timestamp()
      and channels.enabled
      and channels.configured
    order by
      case events.severity when 'critical' then 1 when 'warning' then 2 else 3 end,
      events.occurred_at,
      deliveries.id
    for update of deliveries skip locked
    limit p_limit
  ), claimed as (
    update public.notification_deliveries as deliveries
    set status = 'sending',
        attempts = deliveries.attempts + 1,
        claim_token = p_claim_token,
        claimed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    from picked
    where deliveries.id = picked.id
    returning deliveries.*
  )
  select
    claimed.id,
    claimed.event_id,
    claimed.channel_id,
    claimed.provider_type,
    events.event_type,
    events.source_type,
    events.source_public_id,
    events.severity,
    events.title,
    events.message,
    events.detail_href,
    events.occurred_at,
    claimed.attempts
  from claimed
  join public.notification_events as events on events.id = claimed.event_id
  order by events.occurred_at, claimed.id;
end;
$$;

revoke all on function public.claim_notification_deliveries_v1(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries_v1(text, uuid, integer)
  to service_role;

create or replace function public.notification_event_delivery_block_reason_v1(
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
  v_channel_id smallint;
  v_provider_type text;
  v_channel public.notification_channels%rowtype;
  v_reason text;
begin
  if p_id is null or p_id < 1 or p_claim_token is null then
    return 'claim_mismatch';
  end if;

  select deliveries.channel_id, deliveries.provider_type
  into v_channel_id, v_provider_type
  from public.notification_deliveries as deliveries
  where deliveries.id = p_id
    and deliveries.status = 'sending'
    and deliveries.claim_token = p_claim_token;

  if not found then
    return 'claim_mismatch';
  end if;

  select * into v_channel
  from public.notification_channels as channels
  where channels.id = v_channel_id;

  if not found or v_channel.channel_type <> v_provider_type then
    return 'channel_mismatch';
  end if;
  if not v_channel.enabled then
    return 'channel_disabled_during_dispatch';
  end if;
  if not v_channel.configured then
    return 'channel_unconfigured_during_dispatch';
  end if;

  v_reason := public.notification_status_suppression_reason_v1(clock_timestamp());
  if v_reason is not null then
    return v_reason;
  end if;

  return null;
end;
$$;

revoke all on function public.notification_event_delivery_block_reason_v1(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.notification_event_delivery_block_reason_v1(bigint, uuid)
  to service_role;

create or replace function public.suppress_notification_event_delivery_v1(
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
    raise exception 'notification_event_suppress_invalid' using errcode = '22023';
  end if;

  update public.notification_deliveries
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

revoke all on function public.suppress_notification_event_delivery_v1(bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.suppress_notification_event_delivery_v1(bigint, uuid, text)
  to service_role;

create or replace function public.complete_notification_event_delivery_v1(
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
  v_channel_id smallint;
  v_status text;
  v_backoff_seconds integer;
begin
  if p_id is null or p_id < 1
    or p_claim_token is null
    or p_success is null
    or (p_http_status is not null and p_http_status not between 100 and 599)
    or (p_external_delivery_id is not null and char_length(p_external_delivery_id) > 128)
    or (p_error_code is not null and char_length(p_error_code) > 128) then
    raise exception 'notification_event_complete_invalid' using errcode = '22023';
  end if;

  select deliveries.attempts, deliveries.channel_id
  into v_attempts, v_channel_id
  from public.notification_deliveries as deliveries
  where deliveries.id = p_id
    and deliveries.status = 'sending'
    and deliveries.claim_token = p_claim_token
  for update;

  if not found then
    return 'claim_mismatch';
  end if;

  if p_success then
    update public.notification_deliveries
    set status = 'sent',
        sent_at = clock_timestamp(),
        external_delivery_id = p_external_delivery_id,
        last_http_status = p_http_status,
        last_error_code = null,
        suppression_reason = null,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where id = p_id;

    update public.notification_channels
    set last_delivery_at = clock_timestamp(),
        last_error_code = null,
        updated_at = clock_timestamp()
    where id = v_channel_id;

    return 'sent';
  end if;

  if v_attempts >= 5 then
    v_status := 'failed';
    v_backoff_seconds := 0;
  else
    v_status := 'retry';
    v_backoff_seconds := least(1800, 60 * (1 << greatest(0, v_attempts - 1)));
  end if;

  update public.notification_deliveries
  set status = v_status,
      next_attempt_at = case
        when v_status = 'retry' then clock_timestamp() + make_interval(secs => v_backoff_seconds)
        else next_attempt_at
      end,
      external_delivery_id = null,
      last_http_status = p_http_status,
      last_error_code = coalesce(p_error_code, 'delivery_failed'),
      suppression_reason = null,
      claim_token = null,
      claimed_at = null,
      updated_at = clock_timestamp()
  where id = p_id;

  update public.notification_channels
  set last_error_at = clock_timestamp(),
      last_error_code = coalesce(p_error_code, 'delivery_failed'),
      updated_at = clock_timestamp()
  where id = v_channel_id;

  return v_status;
end;
$$;

revoke all on function public.complete_notification_event_delivery_v1(
  bigint, uuid, boolean, integer, text, text
) from public, anon, authenticated;
grant execute on function public.complete_notification_event_delivery_v1(
  bigint, uuid, boolean, integer, text, text
) to service_role;

-- Preserve the existing Discord configuration RPC while extending its shutdown
-- semantics to the new per-channel delivery queue. Suppressed lifecycle events
-- are intentionally not revived when the channel is re-enabled.
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
  where id = 1
    and channel_type = 'discord';

  if not found then
    raise exception 'notification_discord_channel_missing' using errcode = '40001';
  end if;

  if not (p_enabled and p_configured) then
    v_reason := case when not p_enabled then 'channel_disabled' else 'channel_unconfigured' end;

    update public.notification_outbox
    set status = 'suppressed',
        suppression_reason = v_reason,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where status in ('pending', 'retry', 'sending');

    update public.notification_deliveries
    set status = 'suppressed',
        suppression_reason = v_reason,
        claim_token = null,
        claimed_at = null,
        updated_at = clock_timestamp()
    where channel_id = 1
      and provider_type = 'discord'
      and status in ('pending', 'retry', 'sending');
  end if;
end;
$$;

revoke all on function public.set_notification_channel_v1(boolean, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_notification_channel_v1(boolean, boolean, text)
  to service_role;

comment on table public.notification_events is
  'Append-only logical Status lifecycle events. Contains bounded public presentation data only; no actor/session/webhook/service-role secrets.';
comment on table public.notification_deliveries is
  'Per-channel delivery state for notification_events. One provider failure never mutates another channel delivery.';
comment on function public.create_status_notification_event_v1(
  text, text, text, text, text, text, text, text, timestamptz
) is
  'Private idempotent logical-event creator. Fans out exactly once to the channel snapshot in the same transaction; disabled/unconfigured/global-suppressed channels become permanently suppressed for that event.';
comment on function public.claim_notification_deliveries_v1(text, uuid, integer) is
  'Service-role dispatcher RPC. Claims one provider queue with FOR UPDATE SKIP LOCKED, 5-minute claim recovery, channel gates, and independent attempts.';
comment on function public.notification_event_delivery_block_reason_v1(bigint, uuid) is
  'Service-role pre-send gate for logical-event deliveries. Re-evaluates channel/provider readiness and global suppression immediately before external delivery.';
comment on function public.complete_notification_event_delivery_v1(bigint, uuid, boolean, integer, text, text) is
  'Service-role completion RPC for logical-event deliveries. Retries per channel with exponential backoff and fails after five attempts.';
