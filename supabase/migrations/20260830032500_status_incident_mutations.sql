create or replace function public.status_actor_valid_v1(
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    p_actor_role in ('administrator', 'owner')
    and (
      p_actor_email is null
      or (
        char_length(p_actor_email) between 3 and 320
        and p_actor_email = lower(btrim(p_actor_email))
      )
    )
    and (
      p_actor_discord_user_id is null
      or (
        char_length(p_actor_discord_user_id) between 17 and 20
        and p_actor_discord_user_id ~ '^[0-9]+$'
      )
    )
    and (p_actor_email is not null or p_actor_discord_user_id is not null);
$$;

revoke all on function public.status_actor_valid_v1(text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.create_status_incident_v1(
  p_title text,
  p_impact text,
  p_affected_service_ids text[],
  p_started_at timestamptz,
  p_summary text,
  p_idempotency_key uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_incidents
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_title text := btrim(p_title);
  v_summary text := btrim(p_summary);
  v_existing public.status_incidents%rowtype;
  v_incident public.status_incidents%rowtype;
begin
  if p_idempotency_key is null then
    raise exception 'status_incident_idempotency_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_incident_actor_forbidden' using errcode = '42501';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 160 then
    raise exception 'status_incident_title_invalid' using errcode = '22023';
  end if;
  if p_impact not in ('none', 'minor', 'major', 'critical') then
    raise exception 'status_incident_impact_invalid' using errcode = '22023';
  end if;
  if not public.status_service_ids_valid_v1(p_affected_service_ids) then
    raise exception 'status_incident_services_invalid' using errcode = '22023';
  end if;
  if p_started_at is null
    or p_started_at < v_now - interval '30 days'
    or p_started_at > v_now + interval '5 minutes' then
    raise exception 'status_incident_started_at_invalid' using errcode = '22023';
  end if;
  if v_summary is null or char_length(v_summary) not between 1 and 2000 then
    raise exception 'status_incident_summary_invalid' using errcode = '22023';
  end if;

  select * into v_existing
  from public.status_incidents i
  where i.create_request_id = p_idempotency_key;

  if found then
    if v_existing.title <> v_title
      or v_existing.impact <> p_impact
      or v_existing.affected_service_ids <> p_affected_service_ids
      or v_existing.started_at <> p_started_at
      or v_existing.summary <> v_summary
      or v_existing.source_type <> 'manual' then
      raise exception 'status_incident_idempotency_conflict' using errcode = '23505';
    end if;
    return next v_existing;
    return;
  end if;

  insert into public.status_incidents (
    title,
    lifecycle_status,
    impact,
    affected_service_ids,
    source_type,
    source_ref,
    started_at,
    summary,
    publication_state,
    create_request_id
  ) values (
    v_title,
    'investigating',
    p_impact,
    p_affected_service_ids,
    'manual',
    null,
    p_started_at,
    v_summary,
    'draft',
    p_idempotency_key
  )
  on conflict (create_request_id) do nothing
  returning * into v_incident;

  if not found then
    select * into v_existing
    from public.status_incidents i
    where i.create_request_id = p_idempotency_key;
    if not found then
      raise exception 'status_incident_idempotency_resolution_failed' using errcode = '40001';
    end if;
    if v_existing.title <> v_title
      or v_existing.impact <> p_impact
      or v_existing.affected_service_ids <> p_affected_service_ids
      or v_existing.started_at <> p_started_at
      or v_existing.summary <> v_summary
      or v_existing.source_type <> 'manual' then
      raise exception 'status_incident_idempotency_conflict' using errcode = '23505';
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
    'STATUS_INCIDENT_CREATE',
    'status_incident',
    v_incident.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_incident.public_id,
      'impact', v_incident.impact,
      'affectedServiceIds', v_incident.affected_service_ids,
      'startedAt', v_incident.started_at
    ))
  );

  return next v_incident;
end;
$$;

revoke all on function public.create_status_incident_v1(
  text, text, text[], timestamptz, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_status_incident_v1(
  text, text, text[], timestamptz, text, uuid, text, text, text
) to service_role;

create or replace function public.publish_status_incident_v1(
  p_public_id text,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_incidents
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_incident public.status_incidents%rowtype;
begin
  if p_request_id is null then
    raise exception 'status_incident_request_id_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_incident_actor_forbidden' using errcode = '42501';
  end if;
  if p_public_id is null or p_public_id !~ '^INC-[A-F0-9]{12}$' then
    raise exception 'status_incident_public_id_invalid' using errcode = '22023';
  end if;

  select * into v_incident
  from public.status_incidents i
  where i.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_incident_not_found' using errcode = 'P0002';
  end if;
  if v_incident.publication_state = 'archived' then
    raise exception 'status_incident_archived' using errcode = '22023';
  end if;
  if v_incident.publication_state = 'published' then
    return next v_incident;
    return;
  end if;

  update public.status_incidents
  set publication_state = 'published',
      published_at = v_now,
      updated_at = v_now
  where id = v_incident.id
  returning * into v_incident;

  insert into public.status_incident_updates (
    incident_id,
    lifecycle_status,
    message,
    published_at,
    request_id
  ) values (
    v_incident.id,
    v_incident.lifecycle_status,
    v_incident.summary,
    v_now,
    p_request_id
  ) on conflict (request_id) do nothing;

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'STATUS_INCIDENT_PUBLISH',
    'status_incident',
    v_incident.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_incident.public_id,
      'lifecycleStatus', v_incident.lifecycle_status,
      'impact', v_incident.impact
    ))
  );

  return next v_incident;
end;
$$;

revoke all on function public.publish_status_incident_v1(text, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_status_incident_v1(text, uuid, text, text, text)
  to service_role;

create or replace function public.append_status_incident_update_v1(
  p_public_id text,
  p_lifecycle_status text,
  p_message text,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.status_incidents
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_message text := btrim(p_message);
  v_incident public.status_incidents%rowtype;
  v_existing_update public.status_incident_updates%rowtype;
begin
  if p_request_id is null then
    raise exception 'status_incident_request_id_required' using errcode = '22023';
  end if;
  if not public.status_actor_valid_v1(p_actor_email, p_actor_role, p_actor_discord_user_id) then
    raise exception 'status_incident_actor_forbidden' using errcode = '42501';
  end if;
  if p_public_id is null or p_public_id !~ '^INC-[A-F0-9]{12}$' then
    raise exception 'status_incident_public_id_invalid' using errcode = '22023';
  end if;
  if p_lifecycle_status not in ('investigating', 'identified', 'monitoring', 'resolved') then
    raise exception 'status_incident_lifecycle_invalid' using errcode = '22023';
  end if;
  if v_message is null or char_length(v_message) not between 1 and 2000 then
    raise exception 'status_incident_update_message_invalid' using errcode = '22023';
  end if;

  select u.* into v_existing_update
  from public.status_incident_updates u
  where u.request_id = p_request_id;

  if found then
    select * into v_incident
    from public.status_incidents i
    where i.id = v_existing_update.incident_id;
    if not found
      or v_incident.public_id <> p_public_id
      or v_existing_update.lifecycle_status <> p_lifecycle_status
      or v_existing_update.message <> v_message then
      raise exception 'status_incident_update_idempotency_conflict' using errcode = '23505';
    end if;
    return next v_incident;
    return;
  end if;

  select * into v_incident
  from public.status_incidents i
  where i.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_incident_not_found' using errcode = 'P0002';
  end if;
  if v_incident.publication_state <> 'published' then
    raise exception 'status_incident_not_published' using errcode = '22023';
  end if;
  if v_incident.lifecycle_status = 'resolved' then
    raise exception 'status_incident_already_resolved' using errcode = '22023';
  end if;

  if not (
    (v_incident.lifecycle_status = 'investigating' and p_lifecycle_status in ('investigating', 'identified', 'monitoring', 'resolved'))
    or (v_incident.lifecycle_status = 'identified' and p_lifecycle_status in ('identified', 'monitoring', 'resolved'))
    or (v_incident.lifecycle_status = 'monitoring' and p_lifecycle_status in ('monitoring', 'resolved'))
  ) then
    raise exception 'status_incident_transition_invalid' using errcode = '22023';
  end if;

  insert into public.status_incident_updates (
    incident_id,
    lifecycle_status,
    message,
    published_at,
    request_id
  ) values (
    v_incident.id,
    p_lifecycle_status,
    v_message,
    v_now,
    p_request_id
  );

  update public.status_incidents
  set lifecycle_status = p_lifecycle_status,
      summary = v_message,
      resolved_at = case when p_lifecycle_status = 'resolved' then v_now else null end,
      updated_at = v_now
  where id = v_incident.id
  returning * into v_incident;

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    case when p_lifecycle_status = 'resolved'
      then 'STATUS_INCIDENT_RESOLVE'
      else 'STATUS_INCIDENT_UPDATE'
    end,
    'status_incident',
    v_incident.public_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'publicId', v_incident.public_id,
      'lifecycleStatus', v_incident.lifecycle_status,
      'impact', v_incident.impact
    ))
  );

  return next v_incident;
end;
$$;

revoke all on function public.append_status_incident_update_v1(
  text, text, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.append_status_incident_update_v1(
  text, text, text, uuid, text, text, text
) to service_role;

comment on function public.create_status_incident_v1(
  text, text, text[], timestamptz, text, uuid, text, text, text
) is 'Creates one manual draft public Status incident with idempotency and immutable audit metadata. administrator/owner only.';
comment on function public.publish_status_incident_v1(text, uuid, text, text, text)
  is 'Publishes a draft Status incident and appends its initial public update. administrator/owner only.';
comment on function public.append_status_incident_update_v1(
  text, text, text, uuid, text, text, text
) is 'Appends an immutable public incident update, enforces forward-only lifecycle transitions, and resolves the incident when requested. administrator/owner only.';