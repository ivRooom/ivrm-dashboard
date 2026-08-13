create index if not exists discord_console_sessions_created_cursor_idx
  on public.discord_console_sessions (created_at desc, id desc);

create index if not exists audit_logs_discord_auth_cursor_idx
  on public.audit_logs (action, occurred_at desc, id desc)
  where action in (
    'DISCORD_LOGIN_SUCCEEDED',
    'DISCORD_LOGIN_DENIED',
    'DISCORD_SESSION_REVOKED',
    'DISCORD_SESSION_ADMIN_REVOKED'
  );

create or replace function public.list_discord_console_sessions(
  p_actor_session_token_hash text,
  p_status text default 'active',
  p_limit integer default 50,
  p_before_created_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  session_id uuid,
  discord_user_id text,
  discord_username text,
  discord_global_name text,
  discord_avatar_hash text,
  console_role text,
  session_status text,
  created_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  is_current boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_actor public.discord_console_sessions%rowtype;
begin
  if p_actor_session_token_hash is null
    or p_actor_session_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'discord_admin_session_invalid' using errcode = '42501';
  end if;

  if p_status is null
    or p_status not in ('active', 'expired', 'revoked', 'all') then
    raise exception 'discord_session_status_filter_invalid' using errcode = '22023';
  end if;

  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'discord_session_list_limit_invalid' using errcode = '22023';
  end if;

  if (p_before_created_at is null) <> (p_before_id is null) then
    raise exception 'discord_session_cursor_invalid' using errcode = '22023';
  end if;

  select sessions.*
    into v_actor
    from public.discord_console_sessions as sessions
    where sessions.session_token_hash = p_actor_session_token_hash
      and sessions.revoked_at is null
      and sessions.expires_at > v_now
    limit 1;

  if not found or v_actor.console_role not in ('administrator', 'owner') then
    raise exception 'discord_admin_role_required' using errcode = '42501';
  end if;

  return query
  select
    sessions.id,
    sessions.discord_user_id,
    sessions.discord_username,
    sessions.discord_global_name,
    sessions.discord_avatar_hash,
    sessions.console_role,
    case
      when sessions.revoked_at is not null then 'revoked'
      when sessions.expires_at <= v_now then 'expired'
      else 'active'
    end,
    sessions.created_at,
    sessions.last_seen_at,
    sessions.expires_at,
    sessions.revoked_at,
    sessions.revoke_reason,
    sessions.id = v_actor.id
  from public.discord_console_sessions as sessions
  where
    (
      p_status = 'all'
      or (
        p_status = 'active'
        and sessions.revoked_at is null
        and sessions.expires_at > v_now
      )
      or (
        p_status = 'expired'
        and sessions.revoked_at is null
        and sessions.expires_at <= v_now
      )
      or (
        p_status = 'revoked'
        and sessions.revoked_at is not null
      )
    )
    and (
      p_before_created_at is null
      or (sessions.created_at, sessions.id) < (p_before_created_at, p_before_id)
    )
  order by sessions.created_at desc, sessions.id desc
  limit p_limit;
end;
$$;

create or replace function public.revoke_discord_console_session_by_id(
  p_request_id uuid,
  p_actor_session_token_hash text,
  p_target_session_id uuid
)
returns table (
  outcome text,
  target_was_current boolean,
  target_console_role text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_actor public.discord_console_sessions%rowtype;
  v_target public.discord_console_sessions%rowtype;
  v_self boolean;
begin
  if p_request_id is null or p_target_session_id is null then
    raise exception 'discord_admin_revoke_required_field_missing' using errcode = '22023';
  end if;

  if p_actor_session_token_hash is null
    or p_actor_session_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'discord_admin_session_invalid' using errcode = '42501';
  end if;

  select sessions.*
    into v_actor
    from public.discord_console_sessions as sessions
    where sessions.session_token_hash = p_actor_session_token_hash
      and sessions.revoked_at is null
      and sessions.expires_at > v_now
    limit 1;

  if not found or v_actor.console_role not in ('administrator', 'owner') then
    raise exception 'discord_admin_role_required' using errcode = '42501';
  end if;

  select sessions.*
    into v_target
    from public.discord_console_sessions as sessions
    where sessions.id = p_target_session_id
    for update;

  if not found then
    return query select 'not_found'::text, false, null::text;
    return;
  end if;

  v_self := v_target.id = v_actor.id;

  if v_actor.console_role = 'administrator'
    and v_target.console_role = 'owner' then
    perform public.append_audit_log(
      p_request_id,
      null,
      null,
      v_actor.console_role,
      null,
      'DISCORD_SESSION_ADMIN_REVOKED',
      'discord:session',
      v_target.id::text,
      'denied',
      jsonb_build_object(
        'actorDiscordUserId', v_actor.discord_user_id,
        'targetDiscordUserId', v_target.discord_user_id,
        'targetConsoleRole', v_target.console_role,
        'reason', 'owner_session_protected'
      )
    );

    return query select 'denied'::text, v_self, v_target.console_role;
    return;
  end if;

  if v_target.revoked_at is not null then
    return query select 'unchanged'::text, v_self, v_target.console_role;
    return;
  end if;

  if v_target.expires_at <= v_now then
    update public.discord_console_sessions as sessions
      set revoked_at = v_now,
          revoke_reason = 'expired'
      where sessions.id = v_target.id
        and sessions.revoked_at is null;

    return query select 'unchanged'::text, v_self, v_target.console_role;
    return;
  end if;

  update public.discord_console_sessions as sessions
    set revoked_at = v_now,
        revoke_reason = 'administrator'
    where sessions.id = v_target.id
      and sessions.revoked_at is null;

  perform public.append_audit_log(
    p_request_id,
    null,
    null,
    v_actor.console_role,
    null,
    'DISCORD_SESSION_ADMIN_REVOKED',
    'discord:session',
    v_target.id::text,
    'success',
    jsonb_build_object(
      'actorDiscordUserId', v_actor.discord_user_id,
      'targetDiscordUserId', v_target.discord_user_id,
      'targetConsoleRole', v_target.console_role,
      'selfRevocation', v_self,
      'reason', 'administrator'
    )
  );

  return query select 'revoked'::text, v_self, v_target.console_role;
end;
$$;

create or replace function public.list_discord_auth_audit_logs(
  p_actor_session_token_hash text,
  p_action text default null,
  p_result text default null,
  p_limit integer default 50,
  p_before_occurred_at timestamptz default null,
  p_before_id bigint default null
)
returns table (
  audit_id bigint,
  request_id uuid,
  action text,
  result text,
  actor_role text,
  target_id text,
  discord_user_id text,
  reason text,
  console_role text,
  occurred_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_actor public.discord_console_sessions%rowtype;
begin
  if p_actor_session_token_hash is null
    or p_actor_session_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'discord_admin_session_invalid' using errcode = '42501';
  end if;

  if p_action is not null and p_action not in (
    'DISCORD_LOGIN_SUCCEEDED',
    'DISCORD_LOGIN_DENIED',
    'DISCORD_SESSION_REVOKED',
    'DISCORD_SESSION_ADMIN_REVOKED'
  ) then
    raise exception 'discord_audit_action_filter_invalid' using errcode = '22023';
  end if;

  if p_result is not null
    and p_result not in ('success', 'denied', 'conflict', 'error') then
    raise exception 'discord_audit_result_filter_invalid' using errcode = '22023';
  end if;

  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'discord_audit_list_limit_invalid' using errcode = '22023';
  end if;

  if (p_before_occurred_at is null) <> (p_before_id is null) then
    raise exception 'discord_audit_cursor_invalid' using errcode = '22023';
  end if;

  select sessions.*
    into v_actor
    from public.discord_console_sessions as sessions
    where sessions.session_token_hash = p_actor_session_token_hash
      and sessions.revoked_at is null
      and sessions.expires_at > v_now
    limit 1;

  if not found or v_actor.console_role not in ('administrator', 'owner') then
    raise exception 'discord_admin_role_required' using errcode = '42501';
  end if;

  return query
  select
    logs.id,
    logs.request_id,
    logs.action,
    logs.result,
    logs.actor_role,
    logs.target_id,
    coalesce(
      logs.metadata ->> 'targetDiscordUserId',
      logs.metadata ->> 'discordUserId',
      case when logs.target_type = 'discord:user' then logs.target_id else null end
    ),
    logs.metadata ->> 'reason',
    coalesce(
      logs.metadata ->> 'targetConsoleRole',
      logs.metadata ->> 'consoleRole'
    ),
    logs.occurred_at
  from public.audit_logs as logs
  where logs.action in (
      'DISCORD_LOGIN_SUCCEEDED',
      'DISCORD_LOGIN_DENIED',
      'DISCORD_SESSION_REVOKED',
      'DISCORD_SESSION_ADMIN_REVOKED'
    )
    and (p_action is null or logs.action = p_action)
    and (p_result is null or logs.result = p_result)
    and (
      p_before_occurred_at is null
      or (logs.occurred_at, logs.id) < (p_before_occurred_at, p_before_id)
    )
  order by logs.occurred_at desc, logs.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_discord_console_sessions(
  text, text, integer, timestamptz, uuid
) from public, anon, authenticated;
revoke all on function public.revoke_discord_console_session_by_id(
  uuid, text, uuid
) from public, anon, authenticated;
revoke all on function public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
) from public, anon, authenticated;

grant execute on function public.list_discord_console_sessions(
  text, text, integer, timestamptz, uuid
) to service_role;
grant execute on function public.revoke_discord_console_session_by_id(
  uuid, text, uuid
) to service_role;
grant execute on function public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
) to service_role;

comment on function public.list_discord_console_sessions(
  text, text, integer, timestamptz, uuid
) is '有効なAdministrator／Owner Sessionを再照合し、Token HashとRole IDを除外したDiscord Session一覧を返す。';
comment on function public.revoke_discord_console_session_by_id(
  uuid, text, uuid
) is '現在の管理Sessionを再照合し、AdministratorからOwner Sessionを保護しながら対象Sessionを冪等に失効する。';
comment on function public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
) is '有効なAdministrator／Owner Sessionを再照合し、Discord認証関連だけの監査履歴を返す。';
