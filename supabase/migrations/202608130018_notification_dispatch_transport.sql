create extension if not exists pg_net with schema extensions;

create or replace function public.kick_notification_dispatch_v1()
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, vault, net
as $$
declare
  v_token text;
  v_request_id bigint;
begin
  if not exists (
    select 1
    from public.notification_channels as channels
    where channels.id = 1
      and channels.enabled
      and channels.configured
  ) then
    return null;
  end if;

  select secrets.decrypted_secret
  into v_token
  from vault.decrypted_secrets as secrets
  where secrets.name = 'ivrm_notification_dispatch_token'
  order by secrets.updated_at desc
  limit 1;

  if v_token is null or char_length(v_token) < 32 or char_length(v_token) > 256 then
    update public.notification_dispatch_state
    set last_invoked_at = clock_timestamp(),
        last_error_at = clock_timestamp(),
        last_error_code = 'scheduler_token_missing',
        updated_at = clock_timestamp()
    where id = 1;
    return null;
  end if;

  select net.http_post(
    url := 'https://drazbrcqnjxjuygfxmlz.supabase.co/functions/v1/notification-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-ivrm-dispatch-token', v_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  ) into v_request_id;

  return v_request_id;
end;
$$;

select cron.schedule(
  'ivrm-notification-dispatch-v1',
  '* * * * *',
  $cron$select public.kick_notification_dispatch_v1();$cron$
);

revoke all on function public.kick_notification_dispatch_v1()
  from public, anon, authenticated;
grant execute on function public.kick_notification_dispatch_v1()
  to service_role;

comment on function public.kick_notification_dispatch_v1() is
  'Channelが有効かつ設定済みの場合のみVaultのScheduler TokenでNotification Dispatcher Edge Functionを非同期起動する。Discord Webhook URLはDBへ渡さない。';