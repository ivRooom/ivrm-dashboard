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

  -- Resolve a previously successful request before validations whose outcome can
  -- change with time or linked Reliability state. The payload must still match
  -- exactly, otherwise reusing the key is a conflict.
  select * into v_existing
  from public.status_maintenance_notices m
  where m.create_request_id = p_idempotency_key;

  if found then
    if v_existing.title is distinct from v_title
      or v_existing.body is distinct from v_body
      or v_existing.affected_service_ids is distinct from p_affected_service_ids
      or v_existing.starts_at is distinct from p_starts_at
      or v_existing.ends_at is distinct from p_ends_at
      or v_existing.reliability_window_id is distinct from p_reliability_window_id then
      raise exception 'status_maintenance_idempotency_conflict' using errcode = '23505';
    end if;
    return next v_existing;
    return;
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
    if v_existing.title is distinct from v_title
      or v_existing.body is distinct from v_body
      or v_existing.affected_service_ids is distinct from p_affected_service_ids
      or v_existing.starts_at is distinct from p_starts_at
      or v_existing.ends_at is distinct from p_ends_at
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

comment on function public.create_status_maintenance_v1(
  text, text, text[], timestamptz, timestamptz, uuid, uuid, text, text, text
) is 'Creates one draft public Maintenance notice. Existing idempotency keys are payload-checked and resolved before time- or Reliability-dependent eligibility validation. administrator/owner only.';
