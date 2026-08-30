drop function if exists public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
);

create function public.list_discord_auth_audit_logs(
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
  provider_error text,
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
    case
      when logs.metadata ->> 'providerError' ~ '^[a-z0-9_]{1,64}$'
        then logs.metadata ->> 'providerError'
      else null
    end,
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

revoke all on function public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
) from public, anon, authenticated;

grant execute on function public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
) to service_role;

comment on function public.list_discord_auth_audit_logs(
  text, text, text, integer, timestamptz, bigint
) is '有効なAdministrator／Owner Sessionを再照合し、Discord認証関連監査とsanitized Provider error codeだけを返す。';
