create table public.reliability_maintenance_windows (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null,
  service_id text,
  host_id uuid,
  container_name text,
  backup_target text,
  game_mode text,
  backup_type text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reliability_maintenance_windows_scope_type_check check (
    scope_type in ('service', 'host', 'container', 'backup')
  ),
  constraint reliability_maintenance_windows_service_id_check check (
    service_id is null or service_id in ('overall', 'host', 'container', 'backup')
  ),
  constraint reliability_maintenance_windows_target_shape_check check (
    (
      scope_type = 'service'
      and service_id is not null
      and host_id is null
      and container_name is null
      and backup_target is null
      and game_mode is null
      and backup_type is null
    )
    or (
      scope_type = 'host'
      and service_id is null
      and host_id is not null
      and container_name is null
      and backup_target is null
      and game_mode is null
      and backup_type is null
    )
    or (
      scope_type = 'container'
      and service_id is null
      and host_id is not null
      and container_name is not null
      and backup_target is null
      and game_mode is null
      and backup_type is null
    )
    or (
      scope_type = 'backup'
      and service_id is null
      and host_id is not null
      and container_name is null
      and backup_target is not null
      and game_mode is not null
      and backup_type is not null
    )
  ),
  constraint reliability_maintenance_windows_container_name_check check (
    container_name is null
    or container_name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$'
  ),
  constraint reliability_maintenance_windows_backup_target_check check (
    backup_target is null
    or backup_target ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
  ),
  constraint reliability_maintenance_windows_game_mode_check check (
    game_mode is null
    or game_mode ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
  ),
  constraint reliability_maintenance_windows_backup_type_check check (
    backup_type is null
    or backup_type in ('world', 'config', 'permissions', 'full')
  ),
  constraint reliability_maintenance_windows_time_check check (
    ends_at > starts_at
    and ends_at <= starts_at + interval '7 days'
  ),
  constraint reliability_maintenance_windows_reason_check check (
    char_length(reason) between 1 and 200
    and reason = btrim(reason)
  ),
  constraint reliability_maintenance_windows_cancelled_check check (
    cancelled_at is null or cancelled_at < ends_at
  ),
  constraint reliability_maintenance_windows_host_fkey
    foreign key (host_id) references public.hosts(id) on delete restrict,
  constraint reliability_maintenance_windows_container_fkey
    foreign key (host_id, container_name)
    references public.container_expectations(host_id, container_name)
    on delete restrict,
  constraint reliability_maintenance_windows_backup_fkey
    foreign key (host_id, backup_target, game_mode, backup_type)
    references public.backup_policies(host_id, backup_target, game_mode, backup_type)
    on delete restrict
);

create index reliability_maintenance_windows_range_idx
  on public.reliability_maintenance_windows (starts_at, ends_at);
create index reliability_maintenance_windows_host_idx
  on public.reliability_maintenance_windows (host_id, starts_at)
  where host_id is not null;
create index reliability_maintenance_windows_container_idx
  on public.reliability_maintenance_windows (host_id, container_name)
  where container_name is not null;
create index reliability_maintenance_windows_backup_idx
  on public.reliability_maintenance_windows (
    host_id,
    backup_target,
    game_mode,
    backup_type
  ) where backup_target is not null;

alter table public.reliability_maintenance_windows enable row level security;
alter table public.reliability_maintenance_windows force row level security;

revoke all on table public.reliability_maintenance_windows
  from public, anon, authenticated, service_role;
grant select on table public.reliability_maintenance_windows to service_role;

create or replace function public.create_reliability_maintenance_window_v1(
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
  p_request_id uuid,
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
begin
  if p_request_id is null then
    raise exception 'maintenance_request_id_required' using errcode = '22023';
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

  -- SLOを後から都合よく書き換えないため、過去Windowの新規登録は許可しない。
  -- UI/API処理の時刻差だけ5分まで許容する。
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
    reason
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
    v_reason
  ) returning * into v_window;

  perform public.append_audit_log(
    p_request_id,
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

create or replace function public.cancel_reliability_maintenance_window_v1(
  p_window_id uuid,
  p_request_id uuid,
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
  v_window public.reliability_maintenance_windows%rowtype;
begin
  if p_window_id is null or p_request_id is null then
    raise exception 'maintenance_cancel_required_field_missing' using errcode = '22023';
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

  select *
    into v_window
    from public.reliability_maintenance_windows w
    where w.id = p_window_id
    for update;

  if not found then
    raise exception 'maintenance_window_not_found' using errcode = 'P0002';
  end if;

  -- Retry-safe: 既に取消済みなら状態をそのまま返す。
  if v_window.cancelled_at is not null then
    return next v_window;
    return;
  end if;

  if v_window.ends_at <= v_now then
    raise exception 'maintenance_window_already_ended' using errcode = '22023';
  end if;

  update public.reliability_maintenance_windows w
    set cancelled_at = v_now
    where w.id = p_window_id
    returning * into v_window;

  perform public.append_audit_log(
    p_request_id,
    null,
    p_actor_email,
    p_actor_role,
    null,
    'RELIABILITY_MAINTENANCE_CANCEL',
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
      'endsAt', v_window.ends_at,
      'cancelledAt', v_window.cancelled_at
    ))
  );

  return next v_window;
end;
$$;

revoke all on function public.create_reliability_maintenance_window_v1(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.create_reliability_maintenance_window_v1(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) to service_role;

revoke all on function public.cancel_reliability_maintenance_window_v1(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.cancel_reliability_maintenance_window_v1(
  uuid, uuid, text, text, text
) to service_role;

comment on table public.reliability_maintenance_windows is
  'Audited, explicitly scoped planned-maintenance windows used only for SLO downtime exclusion. Raw incident downtime remains unchanged.';
comment on function public.create_reliability_maintenance_window_v1(
  text, text, uuid, text, text, text, text,
  timestamptz, timestamptz, text, uuid, text, text, text
) is
  'Creates a future/current scoped Reliability maintenance window and atomically appends a hash-chained audit entry. Retrospective creation beyond five minutes is rejected.';
comment on function public.cancel_reliability_maintenance_window_v1(
  uuid, uuid, text, text, text
) is
  'Cancels a scoped Reliability maintenance window and atomically appends a hash-chained audit entry. Cancellation truncates the effective exclusion interval.';
