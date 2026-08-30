create table public.status_announcement_mutation_requests (
  request_id uuid primary key,
  announcement_id uuid not null references public.status_announcements(id) on delete restrict,
  action text not null,
  created_at timestamptz not null default now(),
  constraint status_announcement_mutation_requests_action_check check (
    action in ('publish', 'archive')
  )
);

create index status_announcement_mutation_requests_notice_idx
  on public.status_announcement_mutation_requests (announcement_id, created_at desc);

alter table public.status_announcement_mutation_requests enable row level security;
alter table public.status_announcement_mutation_requests force row level security;

revoke all on table public.status_announcement_mutation_requests
  from public, anon, authenticated, service_role;

create or replace function public.prevent_status_announcement_request_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'status_announcement_mutation_requests_are_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.prevent_status_announcement_request_mutation_v1()
  from public, anon, authenticated, service_role;

create trigger status_announcement_mutation_requests_immutable
before update or delete on public.status_announcement_mutation_requests
for each row execute function public.prevent_status_announcement_request_mutation_v1();

create or replace function public.create_status_announcement_v1(
  p_kind text,
  p_title text,
  p_body text,
  p_affected_service_ids text[],
  p_publish_at timestamptz,
  p_expires_at timestamptz,
  p_idempotency_key uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_announcements
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_title text := btrim(p_title);
  v_body text := btrim(p_body);
  v_existing public.status_announcements%rowtype;
  v_announcement public.status_announcements%rowtype;
begin
  if p_idempotency_key is null then
    raise exception 'status_announcement_idempotency_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_announcement_actor_forbidden' using errcode = '42501';
  end if;

  -- A successful request must stay replayable even after expires_at passes.
  select * into v_existing
  from public.status_announcements a
  where a.create_request_id = p_idempotency_key;

  if found then
    if v_existing.kind is distinct from p_kind
      or v_existing.title is distinct from v_title
      or v_existing.body is distinct from v_body
      or v_existing.affected_service_ids is distinct from p_affected_service_ids
      or v_existing.publish_at is distinct from p_publish_at
      or v_existing.expires_at is distinct from p_expires_at then
      raise exception 'status_announcement_idempotency_conflict' using errcode = '23505';
    end if;
    return next v_existing;
    return;
  end if;

  if p_kind not in ('info', 'warning') then
    raise exception 'status_announcement_kind_invalid' using errcode = '22023';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 160 then
    raise exception 'status_announcement_title_invalid' using errcode = '22023';
  end if;
  if v_body is null or char_length(v_body) not between 1 and 4000 then
    raise exception 'status_announcement_body_invalid' using errcode = '22023';
  end if;
  if p_affected_service_ids is not null
    and not public.status_service_ids_valid_v1(p_affected_service_ids) then
    raise exception 'status_announcement_services_invalid' using errcode = '22023';
  end if;
  if p_publish_at is null then
    raise exception 'status_announcement_publish_at_required' using errcode = '22023';
  end if;
  if p_expires_at is not null
    and (p_expires_at <= p_publish_at or p_expires_at <= v_now) then
    raise exception 'status_announcement_expiry_invalid' using errcode = '22023';
  end if;

  insert into public.status_announcements (
    kind,
    title,
    body,
    affected_service_ids,
    publish_at,
    expires_at,
    publication_state,
    create_request_id
  ) values (
    p_kind,
    v_title,
    v_body,
    p_affected_service_ids,
    p_publish_at,
    p_expires_at,
    'draft',
    p_idempotency_key
  )
  on conflict (create_request_id) do nothing
  returning * into v_announcement;

  if not found then
    select * into v_existing
    from public.status_announcements a
    where a.create_request_id = p_idempotency_key;
    if not found then
      raise exception 'status_announcement_idempotency_resolution_failed' using errcode = '40001';
    end if;
    if v_existing.kind is distinct from p_kind
      or v_existing.title is distinct from v_title
      or v_existing.body is distinct from v_body
      or v_existing.affected_service_ids is distinct from p_affected_service_ids
      or v_existing.publish_at is distinct from p_publish_at
      or v_existing.expires_at is distinct from p_expires_at then
      raise exception 'status_announcement_idempotency_conflict' using errcode = '23505';
    end if;
    return next v_existing;
    return;
  end if;

  perform public.append_audit_log(
    p_idempotency_key,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'STATUS_ANNOUNCEMENT_CREATE',
    'status_announcement',
    v_announcement.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_announcement.public_id,
      'kind', v_announcement.kind,
      'affectedServiceIds', v_announcement.affected_service_ids,
      'publishAt', v_announcement.publish_at,
      'expiresAt', v_announcement.expires_at
    ))
  );

  return next v_announcement;
end;
$$;

revoke all on function public.create_status_announcement_v1(
  text, text, text, text[], timestamptz, timestamptz, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_status_announcement_v1(
  text, text, text, text[], timestamptz, timestamptz, uuid, text, text, text
) to service_role;

create or replace function public.publish_status_announcement_v1(
  p_public_id text,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_announcements
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_announcement public.status_announcements%rowtype;
  v_existing_request public.status_announcement_mutation_requests%rowtype;
  v_already_published boolean := false;
begin
  if p_request_id is null then
    raise exception 'status_announcement_request_id_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_announcement_actor_forbidden' using errcode = '42501';
  end if;
  if p_public_id is null or p_public_id !~ '^ANN-[A-F0-9]{12}$' then
    raise exception 'status_announcement_public_id_invalid' using errcode = '22023';
  end if;

  select * into v_announcement
  from public.status_announcements a
  where a.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_announcement_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing_request
  from public.status_announcement_mutation_requests r
  where r.request_id = p_request_id;

  if found then
    if v_existing_request.announcement_id <> v_announcement.id
      or v_existing_request.action <> 'publish' then
      raise exception 'status_announcement_request_conflict' using errcode = '23505';
    end if;
    return next v_announcement;
    return;
  end if;

  if v_announcement.publication_state = 'archived' then
    raise exception 'status_announcement_archived' using errcode = '22023';
  end if;

  v_already_published := v_announcement.publication_state = 'published';
  if not v_already_published then
    if v_announcement.expires_at is not null and v_announcement.expires_at <= v_now then
      raise exception 'status_announcement_already_expired' using errcode = '22023';
    end if;
    update public.status_announcements
    set publication_state = 'published',
        published_at = v_now,
        updated_at = v_now
    where id = v_announcement.id
    returning * into v_announcement;
  end if;

  insert into public.status_announcement_mutation_requests (
    request_id,
    announcement_id,
    action
  ) values (
    p_request_id,
    v_announcement.id,
    'publish'
  );

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'STATUS_ANNOUNCEMENT_PUBLISH',
    'status_announcement',
    v_announcement.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_announcement.public_id,
      'kind', v_announcement.kind,
      'publishAt', v_announcement.publish_at,
      'expiresAt', v_announcement.expires_at,
      'alreadyPublished', v_already_published
    ))
  );

  return next v_announcement;
end;
$$;

revoke all on function public.publish_status_announcement_v1(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_status_announcement_v1(text, uuid, text, text, text)
  to service_role;

create or replace function public.archive_status_announcement_v1(
  p_public_id text,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_announcements
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_announcement public.status_announcements%rowtype;
  v_existing_request public.status_announcement_mutation_requests%rowtype;
  v_already_archived boolean := false;
begin
  if p_request_id is null then
    raise exception 'status_announcement_request_id_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_announcement_actor_forbidden' using errcode = '42501';
  end if;
  if p_public_id is null or p_public_id !~ '^ANN-[A-F0-9]{12}$' then
    raise exception 'status_announcement_public_id_invalid' using errcode = '22023';
  end if;

  select * into v_announcement
  from public.status_announcements a
  where a.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_announcement_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing_request
  from public.status_announcement_mutation_requests r
  where r.request_id = p_request_id;

  if found then
    if v_existing_request.announcement_id <> v_announcement.id
      or v_existing_request.action <> 'archive' then
      raise exception 'status_announcement_request_conflict' using errcode = '23505';
    end if;
    return next v_announcement;
    return;
  end if;

  if v_announcement.publication_state = 'draft' then
    raise exception 'status_announcement_not_published' using errcode = '22023';
  end if;

  v_already_archived := v_announcement.publication_state = 'archived';
  if not v_already_archived then
    update public.status_announcements
    set publication_state = 'archived',
        archived_at = v_now,
        updated_at = v_now
    where id = v_announcement.id
    returning * into v_announcement;
  end if;

  insert into public.status_announcement_mutation_requests (
    request_id,
    announcement_id,
    action
  ) values (
    p_request_id,
    v_announcement.id,
    'archive'
  );

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'STATUS_ANNOUNCEMENT_ARCHIVE',
    'status_announcement',
    v_announcement.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_announcement.public_id,
      'kind', v_announcement.kind,
      'publishAt', v_announcement.publish_at,
      'expiresAt', v_announcement.expires_at,
      'archivedBeforePublish', v_now < v_announcement.publish_at,
      'alreadyArchived', v_already_archived
    ))
  );

  return next v_announcement;
end;
$$;

revoke all on function public.archive_status_announcement_v1(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.archive_status_announcement_v1(text, uuid, text, text, text)
  to service_role;

create or replace function public.get_status_public_feed_v1(
  p_since timestamptz default (now() - interval '365 days'),
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_since timestamptz;
  v_limit integer;
  v_incidents jsonb;
  v_maintenance jsonb;
  v_announcements jsonb;
begin
  v_since := greatest(
    coalesce(p_since, v_now - interval '365 days'),
    v_now - interval '10 years'
  );
  v_limit := least(greatest(coalesce(p_limit, 200), 1), 500);

  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
    into v_incidents
  from (
    select
      jsonb_build_object(
        'publicId', i.public_id,
        'title', i.title,
        'status', i.lifecycle_status,
        'impact', i.impact,
        'affectedServiceIds', to_jsonb(i.affected_service_ids),
        'startedAt', i.started_at,
        'resolvedAt', i.resolved_at,
        'updatedAt', i.updated_at,
        'summary', i.summary,
        'source', i.source_type,
        'updates', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'status', u.lifecycle_status,
              'message', u.message,
              'publishedAt', u.published_at
            ) order by u.published_at asc, u.id asc
          )
          from public.status_incident_updates u
          where u.incident_id = i.id
        ), '[]'::jsonb)
      ) as item,
      i.updated_at as sort_at
    from public.status_incidents i
    where i.publication_state = 'published'
      and (i.updated_at >= v_since or i.lifecycle_status <> 'resolved')
    order by i.updated_at desc, i.id desc
    limit v_limit
  ) q;

  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
    into v_maintenance
  from (
    select
      jsonb_build_object(
        'publicId', m.public_id,
        'title', m.title,
        'summary', m.body,
        'affectedServiceIds', to_jsonb(m.affected_service_ids),
        'startsAt', m.starts_at,
        'endsAt', m.ends_at,
        'state', case
          when m.publication_state = 'cancelled' then 'cancelled'
          when v_now < m.starts_at then 'scheduled'
          when v_now < m.ends_at then 'in_progress'
          else 'completed'
        end,
        'updatedAt', m.updated_at
      ) as item,
      m.updated_at as sort_at
    from public.status_maintenance_notices m
    where m.publication_state in ('published', 'cancelled')
      and (m.updated_at >= v_since or (m.starts_at <= v_now and m.ends_at >= v_now))
    order by m.updated_at desc, m.id desc
    limit v_limit
  ) q;

  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
    into v_announcements
  from (
    select
      jsonb_build_object(
        'publicId', a.public_id,
        'kind', a.kind,
        'title', a.title,
        'body', a.body,
        'affectedServiceIds', case
          when a.affected_service_ids is null then '[]'::jsonb
          else to_jsonb(a.affected_service_ids)
        end,
        'publishedAt', a.publish_at,
        'expiresAt', a.expires_at,
        'active', (
          a.publication_state = 'published'
          and a.publish_at <= v_now
          and (a.expires_at is null or a.expires_at > v_now)
        )
      ) as item,
      a.publish_at as sort_at
    from public.status_announcements a
    where a.publication_state in ('published', 'archived')
      and a.publish_at <= v_now
      and a.publish_at >= v_since
      and (
        a.publication_state = 'published'
        or (a.archived_at is not null and a.archived_at >= a.publish_at)
      )
    order by a.publish_at desc, a.id desc
    limit v_limit
  ) q;

  return jsonb_build_object(
    'schemaVersion', '1.0',
    'generatedAt', v_now,
    'incidents', v_incidents,
    'maintenance', v_maintenance,
    'announcements', v_announcements
  );
end;
$$;

revoke all on function public.get_status_public_feed_v1(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.get_status_public_feed_v1(timestamptz, integer)
  to service_role;

comment on table public.status_announcement_mutation_requests is
  'Append-only idempotency ledger for public Announcement publish/archive operations. It is never exposed through the public Status feed.';
comment on function public.create_status_announcement_v1(
  text, text, text, text[], timestamptz, timestamptz, uuid, text, text, text
) is 'Creates one draft public Announcement with idempotency and immutable audit metadata. Existing keys are resolved before expiry-dependent eligibility validation. administrator/owner only.';
comment on function public.publish_status_announcement_v1(text, uuid, text, text, text)
  is 'Publishes or schedules a draft Announcement. Public scheduled/active/expired state is derived from publish_at/expires_at. administrator/owner only.';
comment on function public.archive_status_announcement_v1(text, uuid, text, text, text)
  is 'Archives a published Announcement. Archiving before publish_at acts as cancellation and the public feed permanently suppresses that record. administrator/owner only.';
