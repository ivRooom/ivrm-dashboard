revoke all on function public.update_reliability_slo_policy_v1(
  text,
  numeric,
  boolean,
  uuid,
  text,
  text
) from service_role;

drop function public.update_reliability_slo_policy_v1(
  text,
  numeric,
  boolean,
  uuid,
  text,
  text
);

create or replace function public.update_reliability_slo_policy_v2(
  p_service_id text,
  p_target_percent numeric,
  p_enabled boolean,
  p_request_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns table (
  service_id text,
  target_percent numeric,
  enabled boolean,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_previous public.reliability_slo_policies%rowtype;
  v_updated public.reliability_slo_policies%rowtype;
begin
  if p_request_id is null then
    raise exception 'slo_request_id_required' using errcode = '22023';
  end if;

  if p_actor_role not in ('administrator', 'owner') then
    raise exception 'slo_actor_role_forbidden' using errcode = '42501';
  end if;

  if p_actor_email is not null and (
    char_length(p_actor_email) not between 3 and 320
    or p_actor_email <> lower(btrim(p_actor_email))
  ) then
    raise exception 'slo_actor_email_invalid' using errcode = '22023';
  end if;

  if p_actor_discord_user_id is not null and (
    char_length(p_actor_discord_user_id) not between 17 and 20
    or p_actor_discord_user_id !~ '^[0-9]+$'
  ) then
    raise exception 'slo_actor_discord_user_id_invalid' using errcode = '22023';
  end if;

  if p_actor_email is null and p_actor_discord_user_id is null then
    raise exception 'slo_actor_identity_required' using errcode = '42501';
  end if;

  if p_service_id not in ('overall', 'host', 'container', 'backup') then
    raise exception 'slo_service_id_invalid' using errcode = '22023';
  end if;

  if p_target_percent is not null and (
    p_target_percent <= 0
    or p_target_percent >= 100
    or scale(p_target_percent) > 4
  ) then
    raise exception 'slo_target_percent_invalid' using errcode = '22023';
  end if;

  if coalesce(p_enabled, false) and p_target_percent is null then
    raise exception 'slo_target_required_when_enabled' using errcode = '22023';
  end if;

  select *
    into v_previous
    from public.reliability_slo_policies p
    where p.service_id = p_service_id
    for update;

  if not found then
    raise exception 'slo_policy_not_found' using errcode = 'P0002';
  end if;

  update public.reliability_slo_policies p
    set target_percent = p_target_percent,
        enabled = coalesce(p_enabled, false),
        updated_at = clock_timestamp()
    where p.service_id = p_service_id
    returning p.* into v_updated;

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'SLO_POLICY_UPDATE',
    'reliability_slo_policy',
    p_service_id,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'previousTargetPercent', v_previous.target_percent,
      'previousEnabled', v_previous.enabled,
      'targetPercent', v_updated.target_percent,
      'enabled', v_updated.enabled
    ))
  );

  return query
  select
    v_updated.service_id,
    v_updated.target_percent,
    v_updated.enabled,
    v_updated.updated_at;
end;
$$;

revoke all on function public.update_reliability_slo_policy_v2(
  text,
  numeric,
  boolean,
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;

grant execute on function public.update_reliability_slo_policy_v2(
  text,
  numeric,
  boolean,
  uuid,
  text,
  text,
  text
) to service_role;

comment on function public.update_reliability_slo_policy_v2(
  text,
  numeric,
  boolean,
  uuid,
  text,
  text,
  text
) is
  'Atomically updates one explicit Reliability SLO policy and appends a hash-chained audit entry with an attributable console identity.';
