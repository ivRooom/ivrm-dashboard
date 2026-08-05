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

  update public.discord_console_sessions as sessions
    set revoked_at = v_now,
        revoke_reason = 'replaced'
    where sessions.discord_user_id = p_discord_user_id
      and sessions.revoked_at is null
      and sessions.expires_at > v_now;

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

  select sessions.*
    into v_session
    from public.discord_console_sessions as sessions
    where sessions.session_token_hash = p_session_token_hash
      and sessions.revoked_at is null
      and sessions.expires_at > v_now
    limit 1;

  if not found then
    return;
  end if;

  if v_session.last_seen_at < v_now - interval '5 minutes' then
    update public.discord_console_sessions as sessions
      set last_seen_at = least(v_now, sessions.expires_at)
      where sessions.id = v_session.id;
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

revoke all on function public.create_discord_console_session(
  uuid, text, text, text, text, text, text, text[], text, integer
) from public, anon, authenticated;
revoke all on function public.resolve_discord_console_session(text)
  from public, anon, authenticated;

grant execute on function public.create_discord_console_session(
  uuid, text, text, text, text, text, text, text[], text, integer
) to service_role;
grant execute on function public.resolve_discord_console_session(text)
  to service_role;
