alter table public.reliability_maintenance_windows
  add column create_request_id uuid;

create unique index reliability_maintenance_windows_create_request_key
  on public.reliability_maintenance_windows (create_request_id)
  where create_request_id is not null;

create or replace function public.list_reliability_maintenance_targets_v1()
returns table (
  scope_type text,
  host_id uuid,
  server_id text,
  host_display_name text,
  container_name text,
  backup_target text,
  game_mode text,
  backup_type text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    'host'::text,
    h.id,
    h.server_id,
    h.display_name,
    null::text,
    null::text,
    null::text,
    null::text
  from public.hosts h
  where h.enabled = true

  union all

  select
    'container'::text,
    h.id,
    h.server_id,
    h.display_name,
    c.container_name,
    null::text,
    null::text,
    null::text
  from public.container_expectations c
  join public.hosts h on h.id = c.host_id
  where h.enabled = true

  union all

  select
    'backup'::text,
    h.id,
    h.server_id,
    h.display_name,
    null::text,
    b.backup_target,
    b.game_mode,
    b.backup_type
  from public.backup_policies b
  join public.hosts h on h.id = b.host_id
  where h.enabled = true
    and b.enabled = true

  order by 1, 3, 5 nulls first, 6 nulls first, 7 nulls first, 8 nulls first;
$$;

revoke all on function public.list_reliability_maintenance_targets_v1()
  from public, anon, authenticated;
grant execute on function public.list_reliability_maintenance_targets_v1()
  to service_role;

create or replace function public.create_reliability_maintenance_window_v2(
  p_scope_type text,
  p_service_id text,
  p_host_id uuid,
  p_container_name text,
  p_backup_target text,
  p_game_mode text,
  p_backup_type text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text,
  p_idempotency_key uuid,
  p_actor_email text,
  p_actor_role text,
  p_actor_discord_user_id text
)
returns setof public.reliability_maintenance_windows
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_reason text := btrim(p_reason);
  v_window public.reliability_maintenance_windows%rowtype;
  v_existing public.reliability_maintenance_windows%rowtype;
begin
  if p_idempotency_key is null then
    raise exception 'maintenance_idempotency_key_required' using errcode = '22023';
  end if;

  if p_actor_role not in ('administrator', 'owner') then
    raise exception 'maintenance_actor_role_forbidden' using errcode = '42501';
  end if;

  if p_actor_email is not null and (
    char_length(p_actor_email) not between 3 and 320
    or p_actor_email <> lower(btrim(p_actor_email))
  ) then
    raise exception 'maintenance_actor_email_invalid' using errcode = '22023';
  end if;

  if p_actor_discord_user_id is not null and (
    char_length(p_actor_discord_user_id) not between 17 and 20
    or p_actor_discord_user_id !~ '^[0-9]+$'
  ) then
    raise exception 'maintenance_actor_discord_user_id_invalid' using errcode = '22023';
  end if;

  if p_actor_email is null and p_actor_discord_user_id is null then
    raise exception 'maintenance_actor_identity_required' using errcode = '42501';
  end if;

  if p_scope_type not in ('service', 'host', 'container', 'backup') then
    raise exception 'maintenance_scope_type_invalid' using errcode = '22023';
  end if;

  if v_reason is null or char_length(v_reason) not between 1 and 200 then
    raise exception 'maintenance_reason_invalid' using errcode = '22023';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'maintenance_time_invalid' using errcode = '22023';
  end if;

  if p_ends_at > p_starts_at + interval '7 days' then
    raise exception 'maintenance_duration_too_long' using errcode = '22023';
  end if;

  select *
    into v_existing
    from public.reliability_maintenance_windows w
    where w.create_request_id = p_idempotency_key;

  if found then
    if v_existing.scope_type <> p_scope_type
      or v_existing.service_id is distinct from p_service_id
      or v_existing.host_id is distinct from p_host_id
      or v_existing.container_name is distinct from p_container_name
      or v_existing.backup_target is distinct from p_backup_target
      or v_existing.game_mode is distinct from p_game_mode
      or v_existing.backup_type is distinct from p_backup_type
      or v_existing.starts_at <> p_starts_at
      or v_existing.ends_at <> p_ends_at
      or v_existing.reason <> v_reason then
      raise exception 'maintenance_idempotency_conflict' using errcode = '23505';
    end if;

    return next v_existing;
    return;
  end if;

  -- Retryで既存Windowを返す場合はこの時刻制約を再評価しない。
  -- 新規作成だけ、障害後の恣意的な後付けを防止する。
  if p_starts_at < v_now - interval '5 minutes' then
    raise exception 'maintenance_start_too_old' using errcode = '22023';
  end if;

  if p_starts_at > v_now + interval '365 days' then
    raise exception 'maintenance_start_too_far' using errcode = '22023';
  end if;

  if p_scope_type = 'service' then
    if p_service_id not in ('overall', 'host', 'container', 'backup')
      or p_host_id is not null
      or p_container_name is not null
      or p_backup_target is not null
      or p_game_mode is not null
      or p_backup_type is not null then
      raise exception 'maintenance_service_target_invalid' using errcode = '22023';
    end if;
  elsif p_scope_type = 'host' then
    if p_service_id is not null
      or p_host_id is null
      or p_container_name is not null
      or p_backup_target is not null
      or p_game_mode is not null
      or p_backup_type is not null
      or not exists (
        select 1 from public.hosts h
        where h.id = p_host_id and h.enabled = true
      ) then
      raise exception 'maintenance_host_target_invalid' using errcode = '22023';
    end if;
  elsif p_scope_type = 'container' then
    if p_service_id is not null
      or p_host_id is null
      or p_container_name is null
      or p_backup_target is not null
      or p_game_mode is not null
      or p_backup_type is not null
      or not exists (
        select 1
        from public.container_expectations c
        join public.hosts h on h.id = c.host_id
        where c.host_id = p_host_id
          and c.container_name = p_container_name
          and h.enabled = true
      ) then
      raise exception 'maintenance_container_target_invalid' using errcode = '22023';
    end if;
  else
    if p_service_id is not null
      or p_host_id is null
      or p_container_name is not null
      or p_backup_target is null
      or p_game_mode is null
      or p_backup_type is null
      or not exists (
        select 1
        from public.backup_policies b
        join public.hosts h on h.id = b.host_id
        where b.host_id = p_host_id
          and b.backup_target = p_backup_target
          and b.game_mode = p_game_mode
          and b.backup_type = p_backup_type
          and b.enabled = true
          and h.enabled = true
      ) then
      raise exception 'maintenance_backup_target_invalid' using errcode = '22023';
    end if;
  end if;

  insert into public.reliability_maintenance_windows (
    scope_type,
    service_id,
    host_id,
    container_name,
    backup_target,
    game_mode,
    backup_type,
    starts_at,
    ends_at,
    reason,
    create_request_id
  ) values (
    p_scope_type,
    p_service_id,
    p_host_id,
    p_container_name,
    p_backup_target,
    p_game_mode,
    p_backup_type,
    p_starts_at,
    p_ends_at,
    v_reason,
    p_idempotency_key
  )
  on conflict (create_request_id) where create_request_id is not null
    do nothing
  returning * into v_window;

  if not found then
    select *
      into v_existing
      from public.reliability_maintenance_windows w
      where w.create_request_id = p_idempotency_key;

    if not found then
      raise exception 'maintenance_idempotency_resolution_failed' using errcode = '40001';
    end if;

    if v_existing.scope_type <> p_scope_type
      or v_existing.service_id is distinct from p_service_id
      or v_existing.host_id is distinct from p_host_id
      or v_existing.container_name is distinct from p_container_name
      or v_existing.backup_target is distinct from p_backup_target
      or v_existing.game_mode is distinct from p_game_mode
      or v_existing.backup_type is distinct from p_backup_type
      or v_existing.starts_at <> p_starts_at
      or v_existing.ends_at <> p_ends_at
      or v_existing.reason <> v_reason then
      raise exception 'maintenance_idempotency_conflict' using errcode = '23505';
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
    'RELIABILITY_MAINTENANCE_CREATE',
    'reliability_maintenance_window',
    v_window.id::text,
    'success',
    jsonb_strip_nulls(jsonb_build_object(
      'discordUserId', p_actor_discord_user_id,
      'scopeType', v_window.scope_type,
      'serviceId', v_window.service_id,
      'hostId', v_window.host_id,
      'containerName', v_window.container_name,
      'backupTarget', v_window.backup_target,
      'gameMode', v_window.game_mode,
      'backupType', v_window.backup_type,
      'startsAt', v_window.starts_at,
      'endsAt', v_window.ends_at
    ))
  );

  return next v_window;
end;
$$;

revoke all on function public.create_reliability_maintenance_window_v2(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_reliability_maintenance_window_v2(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) to service_role;

revoke all on function public.create_reliability_maintenance_window_v1(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) from service_role;
drop function public.create_reliability_maintenance_window_v1(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
);

comment on column public.reliability_maintenance_windows.create_request_id is
  'Client-generated UUID used to make create retries idempotent. Legacy rows may be null.';
comment on function public.list_reliability_maintenance_targets_v1() is
  'Returns the enabled Host, Container, and Backup target catalog required by the Reliability maintenance editor without granting direct access to backup_policies.';
comment on function public.create_reliability_maintenance_window_v2(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) is
  'Creates a scoped Reliability maintenance window exactly once for a client UUID and atomically appends the hash-chained audit entry. Matching retries return the original row; conflicting reuse is rejected.';
