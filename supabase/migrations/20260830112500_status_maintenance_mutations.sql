create table public.status_maintenance_mutation_requests (
  request_id uuid primary key,
  maintenance_id uuid not null references public.status_maintenance_notices(id) on delete restrict,
  action text not null,
  created_at timestamptz not null default now(),
  constraint status_maintenance_mutation_requests_action_check check (
    action in ('publish', 'cancel')
  )
);

create index status_maintenance_mutation_requests_notice_idx
  on public.status_maintenance_mutation_requests (maintenance_id, created_at desc);

alter table public.status_maintenance_mutation_requests enable row level security;
alter table public.status_maintenance_mutation_requests force row level security;

revoke all on table public.status_maintenance_mutation_requests
  from public, anon, authenticated, service_role;

create or replace function public.prevent_status_maintenance_request_mutation_v1()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'status_maintenance_mutation_requests_are_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.prevent_status_maintenance_request_mutation_v1()
  from public, anon, authenticated, service_role;

create trigger status_maintenance_mutation_requests_immutable
before update or delete on public.status_maintenance_mutation_requests
for each row execute function public.prevent_status_maintenance_request_mutation_v1();

create or replace function public.create_status_maintenance_v1(
  p_title text,
  p_body text,
  p_affected_service_ids text[],
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reliability_window_id uuid,
  p_idempotency_key uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_maintenance_notices
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_title text := btrim(p_title);
  v_body text := btrim(p_body);
  v_existing public.status_maintenance_notices%rowtype;
  v_notice public.status_maintenance_notices%rowtype;
begin
  if p_idempotency_key is null then
    raise exception 'status_maintenance_idempotency_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_maintenance_actor_forbidden' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 160 then
    raise exception 'status_maintenance_title_invalid' using errcode = '22023';
  end if;
  if v_body is null or char_length(v_body) not between 1 and 4000 then
    raise exception 'status_maintenance_body_invalid' using errcode = '22023';
  end if;
  if not public.status_service_ids_valid_v1(p_affected_service_ids) then
    raise exception 'status_maintenance_services_invalid' using errcode = '22023';
  end if;
  if p_starts_at is null
    or p_ends_at is null
    or p_ends_at <= p_starts_at
    or p_ends_at > p_starts_at + interval '14 days'
    or p_ends_at <= v_now then
    raise exception 'status_maintenance_schedule_invalid' using errcode = '22023';
  end if;
  if p_reliability_window_id is not null
    and not exists (
      select 1
      from public.reliability_maintenance_windows w
      where w.id = p_reliability_window_id
        and w.cancelled_at is null
    ) then
    raise exception 'status_maintenance_reliability_window_invalid' using errcode = '22023';
  end if;

  select * into v_existing
  from public.status_maintenance_notices m
  where m.create_request_id = p_idempotency_key;

  if found then
    if v_existing.title <> v_title
      or v_existing.body <> v_body
      or v_existing.affected_service_ids <> p_affected_service_ids
      or v_existing.starts_at <> p_starts_at
      or v_existing.ends_at <> p_ends_at
      or v_existing.reliability_window_id is distinct from p_reliability_window_id then
      raise exception 'status_maintenance_idempotency_conflict' using errcode = '23505';
    end if;
    return next v_existing;
    return;
  end if;

  insert into public.status_maintenance_notices (
    title,
    body,
    affected_service_ids,
    starts_at,
    ends_at,
    publication_state,
    reliability_window_id,
    create_request_id
  ) values (
    v_title,
    v_body,
    p_affected_service_ids,
    p_starts_at,
    p_ends_at,
    'draft',
    p_reliability_window_id,
    p_idempotency_key
  )
  on conflict (create_request_id) do nothing
  returning * into v_notice;

  if not found then
    select * into v_existing
    from public.status_maintenance_notices m
    where m.create_request_id = p_idempotency_key;
    if not found then
      raise exception 'status_maintenance_idempotency_resolution_failed' using errcode = '40001';
    end if;
    if v_existing.title <> v_title
      or v_existing.body <> v_body
      or v_existing.affected_service_ids <> p_affected_service_ids
      or v_existing.starts_at <> p_starts_at
      or v_existing.ends_at <> p_ends_at
      or v_existing.reliability_window_id is distinct from p_reliability_window_id then
      raise exception 'status_maintenance_idempotency_conflict' using errcode = '23505';
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
    'STATUS_MAINTENANCE_CREATE',
    'status_maintenance',
    v_notice.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_notice.public_id,
      'affectedServiceIds', v_notice.affected_service_ids,
      'startsAt', v_notice.starts_at,
      'endsAt', v_notice.ends_at,
      'reliabilityWindowId', v_notice.reliability_window_id
    ))
  );

  return next v_notice;
end;
$$;

revoke all on function public.create_status_maintenance_v1(
  text, text, text[], timestamptz, timestamptz, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_status_maintenance_v1(
  text, text, text[], timestamptz, timestamptz, uuid, uuid, text, text, text
) to service_role;

create or replace function public.publish_status_maintenance_v1(
  p_public_id text,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_maintenance_notices
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_notice public.status_maintenance_notices%rowtype;
  v_existing_request public.status_maintenance_mutation_requests%rowtype;
  v_already_published boolean := false;
begin
  if p_request_id is null then
    raise exception 'status_maintenance_request_id_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_maintenance_actor_forbidden' using errcode = '42501';
  end if;
  if p_public_id is null or p_public_id !~ '^MNT-[A-F0-9]{12}$' then
    raise exception 'status_maintenance_public_id_invalid' using errcode = '22023';
  end if;

  select * into v_notice
  from public.status_maintenance_notices m
  where m.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_maintenance_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing_request
  from public.status_maintenance_mutation_requests r
  where r.request_id = p_request_id;

  if found then
    if v_existing_request.maintenance_id <> v_notice.id
      or v_existing_request.action <> 'publish' then
      raise exception 'status_maintenance_request_conflict' using errcode = '23505';
    end if;
    return next v_notice;
    return;
  end if;

  if v_notice.publication_state = 'cancelled' then
    raise exception 'status_maintenance_cancelled' using errcode = '22023';
  end if;
  if v_notice.ends_at <= v_now then
    raise exception 'status_maintenance_already_completed' using errcode = '22023';
  end if;

  v_already_published := v_notice.publication_state = 'published';
  if not v_already_published then
    update public.status_maintenance_notices
    set publication_state = 'published',
        published_at = v_now,
        updated_at = v_now
    where id = v_notice.id
    returning * into v_notice;
  end if;

  insert into public.status_maintenance_mutation_requests (
    request_id,
    maintenance_id,
    action
  ) values (
    p_request_id,
    v_notice.id,
    'publish'
  );

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'STATUS_MAINTENANCE_PUBLISH',
    'status_maintenance',
    v_notice.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_notice.public_id,
      'startsAt', v_notice.starts_at,
      'endsAt', v_notice.ends_at,
      'alreadyPublished', v_already_published
    ))
  );

  return next v_notice;
end;
$$;

revoke all on function public.publish_status_maintenance_v1(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_status_maintenance_v1(text, uuid, text, text, text)
  to service_role;

create or replace function public.cancel_status_maintenance_v1(
  p_public_id text,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_maintenance_notices
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_notice public.status_maintenance_notices%rowtype;
  v_existing_request public.status_maintenance_mutation_requests%rowtype;
  v_already_cancelled boolean := false;
begin
  if p_request_id is null then
    raise exception 'status_maintenance_request_id_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_maintenance_actor_forbidden' using errcode = '42501';
  end if;
  if p_public_id is null or p_public_id !~ '^MNT-[A-F0-9]{12}$' then
    raise exception 'status_maintenance_public_id_invalid' using errcode = '22023';
  end if;

  select * into v_notice
  from public.status_maintenance_notices m
  where m.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_maintenance_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing_request
  from public.status_maintenance_mutation_requests r
  where r.request_id = p_request_id;

  if found then
    if v_existing_request.maintenance_id <> v_notice.id
      or v_existing_request.action <> 'cancel' then
      raise exception 'status_maintenance_request_conflict' using errcode = '23505';
    end if;
    return next v_notice;
    return;
  end if;

  if v_notice.publication_state = 'draft' then
    raise exception 'status_maintenance_not_published' using errcode = '22023';
  end if;

  v_already_cancelled := v_notice.publication_state = 'cancelled';
  if not v_already_cancelled then
    if v_now >= v_notice.starts_at then
      raise exception 'status_maintenance_already_started' using errcode = '22023';
    end if;
    update public.status_maintenance_notices
    set publication_state = 'cancelled',
        cancelled_at = v_now,
        updated_at = v_now
    where id = v_notice.id
    returning * into v_notice;
  end if;

  insert into public.status_maintenance_mutation_requests (
    request_id,
    maintenance_id,
    action
  ) values (
    p_request_id,
    v_notice.id,
    'cancel'
  );

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'STATUS_MAINTENANCE_CANCEL',
    'status_maintenance',
    v_notice.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_notice.public_id,
      'startsAt', v_notice.starts_at,
      'endsAt', v_notice.ends_at,
      'alreadyCancelled', v_already_cancelled
    ))
  );

  return next v_notice;
end;
$$;

revoke all on function public.cancel_status_maintenance_v1(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.cancel_status_maintenance_v1(text, uuid, text, text, text)
  to service_role;

comment on table public.status_maintenance_mutation_requests is
  'Append-only idempotency ledger for public Maintenance publish/cancel operations. It is never exposed through the public Status feed.';
comment on function public.create_status_maintenance_v1(
  text, text, text[], timestamptz, timestamptz, uuid, uuid, text, text, text
) is 'Creates one draft public Maintenance notice with idempotency and immutable audit metadata. administrator/owner only.';
comment on function public.publish_status_maintenance_v1(text, uuid, text, text, text)
  is 'Publishes a draft Maintenance notice. Public scheduled/in_progress/completed state remains derived from starts_at/ends_at. administrator/owner only.';
comment on function public.cancel_status_maintenance_v1(text, uuid, text, text, text)
  is 'Cancels a published Maintenance notice before its scheduled start while preserving an append-only request ledger and audit entry. administrator/owner only.';
