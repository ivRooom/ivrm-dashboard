create table if not exists public.discord_console_sessions (
  id uuid primary key default gen_random_uuid(),
  session_token_hash text not null unique,
  discord_user_id text not null,
  discord_username text not null,
  discord_global_name text,
  discord_avatar_hash text,
  guild_id text not null,
  matched_role_ids text[] not null,
  console_role text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  revoke_reason text,
  constraint discord_console_sessions_token_hash_check check (
    session_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint discord_console_sessions_user_id_check check (
    discord_user_id ~ '^[0-9]{17,20}$'
  ),
  constraint discord_console_sessions_username_check check (
    char_length(discord_username) between 1 and 80
  ),
  constraint discord_console_sessions_global_name_check check (
    discord_global_name is null
    or char_length(discord_global_name) between 1 and 80
  ),
  constraint discord_console_sessions_avatar_hash_check check (
    discord_avatar_hash is null
    or (
      char_length(discord_avatar_hash) between 1 and 128
      and discord_avatar_hash ~ '^[A-Za-z0-9_]+$'
    )
  ),
  constraint discord_console_sessions_guild_id_check check (
    guild_id ~ '^[0-9]{17,20}$'
  ),
  constraint discord_console_sessions_roles_check check (
    cardinality(matched_role_ids) between 1 and 16
  ),
  constraint discord_console_sessions_console_role_check check (
    console_role in ('viewer', 'operator', 'administrator', 'owner')
  ),
  constraint discord_console_sessions_expiry_check check (
    expires_at > created_at
  ),
  constraint discord_console_sessions_seen_check check (
    last_seen_at >= created_at
    and last_seen_at <= expires_at
  ),
  constraint discord_console_sessions_revocation_check check (
    (revoked_at is null and revoke_reason is null)
    or (
      revoked_at is not null
      and revoked_at >= created_at
      and revoke_reason in ('logout', 'replaced', 'administrator', 'expired')
    )
  )
);

create index if not exists discord_console_sessions_user_created_idx
  on public.discord_console_sessions (discord_user_id, created_at desc);

create index if not exists discord_console_sessions_active_expiry_idx
  on public.discord_console_sessions (expires_at)
  where revoked_at is null;

alter table public.discord_console_sessions enable row level security;
alter table public.discord_console_sessions force row level security;

revoke all on table public.discord_console_sessions from public, anon, authenticated;
revoke all on table public.discord_console_sessions from service_role;

create or replace function public.create_discord_console_session(
  p_request_id uuid,
  p_session_token_hash text,
  p_discord_user_id text,
  p_discord_username text,
  p_discord_global_name text,
  p_discord_avatar_hash text,
  p_guild_id text,
  p_matched_role_ids text[],
  p_console_role text,
  p_ttl_seconds integer
)
returns table (
  session_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session public.discord_console_sessions%rowtype;
  v_role_id text;
begin
  if p_request_id is null then
    raise exception 'discord_session_request_id_required' using errcode = '22023';
  end if;

  if p_session_token_hash is null
    or p_session_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'discord_session_token_hash_invalid' using errcode = '22023';
  end if;

  if p_discord_user_id is null
    or p_discord_user_id !~ '^[0-9]{17,20}$' then
    raise exception 'discord_user_id_invalid' using errcode = '22023';
  end if;

  if p_discord_username is null
    or char_length(p_discord_username) not between 1 and 80 then
    raise exception 'discord_username_invalid' using errcode = '22023';
  end if;

  if p_discord_global_name is not null
    and char_length(p_discord_global_name) not between 1 and 80 then
    raise exception 'discord_global_name_invalid' using errcode = '22023';
  end if;

  if p_discord_avatar_hash is not null
    and (
      char_length(p_discord_avatar_hash) not between 1 and 128
      or p_discord_avatar_hash !~ '^[A-Za-z0-9_]+$'
    ) then
    raise exception 'discord_avatar_hash_invalid' using errcode = '22023';
  end if;

  if p_guild_id is null or p_guild_id !~ '^[0-9]{17,20}$' then
    raise exception 'discord_guild_id_invalid' using errcode = '22023';
  end if;

  if p_matched_role_ids is null
    or cardinality(p_matched_role_ids) not between 1 and 16 then
    raise exception 'discord_role_ids_invalid' using errcode = '22023';
  end if;

  foreach v_role_id in array p_matched_role_ids loop
    if v_role_id is null or v_role_id !~ '^[0-9]{17,20}$' then
      raise exception 'discord_role_id_invalid' using errcode = '22023';
    end if;
  end loop;

  if p_console_role is null
    or p_console_role not in ('viewer', 'operator', 'administrator', 'owner') then
    raise exception 'discord_console_role_invalid' using errcode = '22023';
  end if;

  if p_ttl_seconds is null or p_ttl_seconds not between 300 and 86400 then
    raise exception 'discord_session_ttl_invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('discord-console-user:' || p_discord_user_id, 0)
  );

  update public.discord_console_sessions
    set revoked_at = v_now,
        revoke_reason = 'replaced'
    where discord_user_id = p_discord_user_id
      and revoked_at is null
      and expires_at > v_now;

  insert into public.discord_console_sessions (
    session_token_hash,
    discord_user_id,
    discord_username,
    discord_global_name,
    discord_avatar_hash,
    guild_id,
    matched_role_ids,
    console_role,
    created_at,
    expires_at,
    last_seen_at
  ) values (
    p_session_token_hash,
    p_discord_user_id,
    p_discord_username,
    p_discord_global_name,
    p_discord_avatar_hash,
    p_guild_id,
    array(
      select distinct role_id
      from unnest(p_matched_role_ids) as role_id
      order by role_id
    ),
    p_console_role,
    v_now,
    v_now + make_interval(secs => p_ttl_seconds),
    v_now
  ) returning * into v_session;

  perform public.append_audit_log(
    p_request_id,
    null,
    null,
    p_console_role,
    null,
    'DISCORD_LOGIN_SUCCEEDED',
    'discord:user',
    p_discord_user_id,
    'success',
    jsonb_build_object(
      'guildId', p_guild_id,
      'consoleRole', p_console_role,
      'matchedRoleCount', cardinality(v_session.matched_role_ids),
      'sessionId', v_session.id,
      'expiresAt', v_session.expires_at
    )
  );

  return query select v_session.id, v_session.expires_at;
end;
$$;

create or replace function public.resolve_discord_console_session(
  p_session_token_hash text
)
returns table (
  session_id uuid,
  discord_user_id text,
  discord_username text,
  discord_global_name text,
  discord_avatar_hash text,
  guild_id text,
  matched_role_ids text[],
  console_role text,
  created_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session public.discord_console_sessions%rowtype;
begin
  if p_session_token_hash is null
    or p_session_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select *
    into v_session
    from public.discord_console_sessions
    where session_token_hash = p_session_token_hash
      and revoked_at is null
      and expires_at > v_now
    limit 1;

  if not found then
    return;
  end if;

  if v_session.last_seen_at < v_now - interval '5 minutes' then
    update public.discord_console_sessions
      set last_seen_at = least(v_now, expires_at)
      where id = v_session.id;
  end if;

  return query select
    v_session.id,
    v_session.discord_user_id,
    v_session.discord_username,
    v_session.discord_global_name,
    v_session.discord_avatar_hash,
    v_session.guild_id,
    v_session.matched_role_ids,
    v_session.console_role,
    v_session.created_at,
    v_session.expires_at;
end;
$$;

create or replace function public.revoke_discord_console_session(
  p_request_id uuid,
  p_session_token_hash text,
  p_reason text default 'logout'
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_session public.discord_console_sessions%rowtype;
begin
  if p_request_id is null then
    raise exception 'discord_session_request_id_required' using errcode = '22023';
  end if;

  if p_session_token_hash is null
    or p_session_token_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  if p_reason is null
    or p_reason not in ('logout', 'administrator', 'expired') then
    raise exception 'discord_session_revoke_reason_invalid' using errcode = '22023';
  end if;

  update public.discord_console_sessions
    set revoked_at = v_now,
        revoke_reason = p_reason
    where session_token_hash = p_session_token_hash
      and revoked_at is null
    returning * into v_session;

  if not found then
    return false;
  end if;

  perform public.append_audit_log(
    p_request_id,
    null,
    null,
    v_session.console_role,
    null,
    'DISCORD_SESSION_REVOKED',
    'discord:session',
    v_session.id::text,
    'success',
    jsonb_build_object(
      'discordUserId', v_session.discord_user_id,
      'reason', p_reason
    )
  );

  return true;
end;
$$;

create or replace function public.expire_discord_console_sessions(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
begin
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'discord_session_expire_limit_invalid' using errcode = '22023';
  end if;

  with candidates as (
    select id
    from public.discord_console_sessions
    where revoked_at is null
      and expires_at <= v_now
    order by expires_at
    limit p_limit
    for update skip locked
  )
  update public.discord_console_sessions sessions
    set revoked_at = v_now,
        revoke_reason = 'expired'
    from candidates
    where sessions.id = candidates.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.create_discord_console_session(
  uuid, text, text, text, text, text, text, text[], text, integer
) from public, anon, authenticated;
revoke all on function public.resolve_discord_console_session(text)
  from public, anon, authenticated;
revoke all on function public.revoke_discord_console_session(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.expire_discord_console_sessions(integer)
  from public, anon, authenticated;

grant execute on function public.create_discord_console_session(
  uuid, text, text, text, text, text, text, text[], text, integer
) to service_role;
grant execute on function public.resolve_discord_console_session(text)
  to service_role;
grant execute on function public.revoke_discord_console_session(uuid, text, text)
  to service_role;
grant execute on function public.expire_discord_console_sessions(integer)
  to service_role;

comment on table public.discord_console_sessions is
  'Discord Role認証後に発行するWebコンソールの短期セッション。OAuth Tokenと平文Session Tokenは保存しない。';
comment on function public.create_discord_console_session(
  uuid, text, text, text, text, text, text, text[], text, integer
) is 'Discord Role判定済み利用者へ短期Sessionを発行し、同一利用者の既存Sessionを失効する。';
comment on function public.resolve_discord_console_session(text) is
  'SHA-256 Session Token Hashを照合し、有効なDiscord Console Sessionだけを返す。';
comment on function public.revoke_discord_console_session(uuid, text, text) is
  'Discord Console Sessionを失効し、Tokenを含まない監査ログを追加する。';
comment on function public.expire_discord_console_sessions(integer) is
  '期限切れDiscord Console Sessionを小分けに失効する。';
