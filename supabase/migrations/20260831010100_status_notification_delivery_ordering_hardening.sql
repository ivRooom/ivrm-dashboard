-- Harden scheduled Announcement timing and stale Status lifecycle delivery ordering.

-- A scheduled Announcement becomes publicly visible at publish_at, not when the
-- administrator executes the publish/schedule mutation. Create the durable event
-- in the mutation transaction but make its occurred_at/next_attempt_at match the
-- actual public publication time.
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

  if new.publish_at is null then
    raise exception 'status_announcement_notification_publish_at_missing' using errcode = '40001';
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
    new.publish_at
  );

  return new;
end;
$$;

revoke all on function public.status_announcement_notification_event_trigger_v1()
  from public, anon, authenticated, service_role;

-- Preserve per-source lifecycle ordering. A later transition cannot overtake an
-- earlier pending/retry/sending delivery for the same channel and public source.
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
      and not exists (
        select 1
        from public.notification_deliveries as earlier_delivery
        join public.notification_events as earlier_event
          on earlier_event.id = earlier_delivery.event_id
        where earlier_delivery.channel_id = deliveries.channel_id
          and earlier_delivery.provider_type = deliveries.provider_type
          and earlier_delivery.status in ('pending', 'retry', 'sending')
          and earlier_event.source_type = events.source_type
          and earlier_event.source_public_id = events.source_public_id
          and (
            earlier_event.occurred_at < events.occurred_at
            or (
              earlier_event.occurred_at = events.occurred_at
              and earlier_delivery.id < deliveries.id
            )
          )
      )
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

-- Re-evaluate source lifecycle immediately before external delivery. This keeps
-- delayed/retried Status notifications from announcing state that is no longer
-- publishable, while the terminal/newer event remains independently deliverable.
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
  v_delivery public.notification_deliveries%rowtype;
  v_event public.notification_events%rowtype;
  v_channel public.notification_channels%rowtype;
  v_incident_lifecycle text;
  v_maintenance_state text;
  v_announcement_state text;
  v_announcement_publish_at timestamptz;
  v_announcement_expires_at timestamptz;
  v_reason text;
begin
  if p_id is null or p_id < 1 or p_claim_token is null then
    return 'claim_mismatch';
  end if;

  select * into v_delivery
  from public.notification_deliveries as deliveries
  where deliveries.id = p_id
    and deliveries.status = 'sending'
    and deliveries.claim_token = p_claim_token;

  if not found then
    return 'claim_mismatch';
  end if;

  select * into v_event
  from public.notification_events as events
  where events.id = v_delivery.event_id;

  if not found then
    return 'event_missing';
  end if;

  select * into v_channel
  from public.notification_channels as channels
  where channels.id = v_delivery.channel_id;

  if not found or v_channel.channel_type <> v_delivery.provider_type then
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

  if v_event.source_type = 'incident'
    and v_event.event_type in ('incident_published', 'incident_update_published') then
    select incidents.lifecycle_status
    into v_incident_lifecycle
    from public.status_incidents as incidents
    where incidents.public_id = v_event.source_public_id;

    if not found then
      return 'incident_missing_during_dispatch';
    end if;
    if v_incident_lifecycle = 'resolved' then
      return 'incident_resolved_before_delivery';
    end if;
  elsif v_event.source_type = 'maintenance'
    and v_event.event_type = 'maintenance_published' then
    select notices.publication_state
    into v_maintenance_state
    from public.status_maintenance_notices as notices
    where notices.public_id = v_event.source_public_id;

    if not found then
      return 'maintenance_missing_during_dispatch';
    end if;
    if v_maintenance_state = 'cancelled' then
      return 'maintenance_cancelled_before_delivery';
    end if;
  elsif v_event.source_type = 'announcement'
    and v_event.event_type = 'announcement_published' then
    select announcements.publication_state,
           announcements.publish_at,
           announcements.expires_at
    into v_announcement_state,
         v_announcement_publish_at,
         v_announcement_expires_at
    from public.status_announcements as announcements
    where announcements.public_id = v_event.source_public_id;

    if not found then
      return 'announcement_missing_during_dispatch';
    end if;
    if v_announcement_state <> 'published' then
      return 'announcement_archived_before_delivery';
    end if;
    if v_announcement_publish_at > clock_timestamp() then
      return 'announcement_not_due';
    end if;
    if v_announcement_expires_at is not null
      and v_announcement_expires_at <= clock_timestamp() then
      return 'announcement_expired_before_delivery';
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.notification_event_delivery_block_reason_v1(bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.notification_event_delivery_block_reason_v1(bigint, uuid)
  to service_role;

comment on function public.claim_notification_deliveries_v1(text, uuid, integer) is
  'Service-role provider claim. Uses SKIP LOCKED, claim recovery, channel/global gates, due time, and per-source/channel ordering so later lifecycle transitions cannot overtake earlier retryable deliveries.';
comment on function public.notification_event_delivery_block_reason_v1(bigint, uuid) is
  'Service-role pre-send gate. Re-evaluates channel/global suppression plus current Incident/Maintenance/Announcement lifecycle so stale delayed deliveries are suppressed before outbound I/O.';
