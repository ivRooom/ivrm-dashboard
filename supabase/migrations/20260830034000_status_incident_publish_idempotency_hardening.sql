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

  select * into v_incident
  from public.status_incidents i
  where i.public_id = p_public_id
  for update;

  if not found then
    raise exception 'status_incident_not_found' using errcode = 'P0002';
  end if;

  select u.* into v_existing_update
  from public.status_incident_updates u
  where u.request_id = p_request_id;

  if found then
    if v_existing_update.incident_id <> v_incident.id
      or v_existing_update.lifecycle_status <> v_incident.lifecycle_status
      or v_existing_update.message <> v_incident.summary then
      raise exception 'status_incident_publish_idempotency_conflict' using errcode = '23505';
    end if;
    if v_incident.publication_state <> 'published' then
      raise exception 'status_incident_publish_state_inconsistent' using errcode = '40001';
    end if;
    return next v_incident;
    return;
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
  );

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
