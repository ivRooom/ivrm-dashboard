create or replace function public.get_console_logs_v2(
  p_server_id text,
  p_source_name text default null,
  p_level text default null,
  p_query text default null,
  p_window_minutes integer default 1440,
  p_after_id bigint default null,
  p_limit integer default 300
)
returns table (
  row_id bigint,
  server_id text,
  host_display_name text,
  source_type text,
  source_name text,
  observed_at timestamptz,
  level text,
  message text,
  received_at timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_query text := nullif(btrim(p_query), '');
  v_statement_at timestamptz := statement_timestamp();
  v_retention_cutoff timestamptz;
  v_window_cutoff timestamptz;
begin
  if p_server_id is null
    or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
    or p_window_minutes is null
    or p_window_minutes not in (5, 15, 60, 360, 1440)
    or p_limit is null
    or p_limit not between 1 and 500
    or (p_source_name is not null and p_source_name not in (
      'mc-main', 'mc-block', 'ivrm-velocity', 'mc-resource', 'mc-resource-router', 'ivrm-agent'
    ))
    or (p_level is not null and p_level not in ('debug', 'info', 'warning', 'error', 'critical'))
    or (v_query is not null and char_length(v_query) > 80)
    or (p_after_id is not null and p_after_id < 0) then
    raise exception 'console_log_query_invalid' using errcode = '22023';
  end if;

  v_retention_cutoff := v_statement_at - interval '24 hours';
  v_window_cutoff := v_statement_at - make_interval(mins => p_window_minutes);

  if p_after_id is null then
    return query
      with latest as (
        select
          entries.id,
          hosts.server_id,
          hosts.display_name,
          entries.source_type,
          entries.source_name,
          entries.observed_at,
          entries.level,
          entries.message,
          entries.received_at
        from public.console_log_entries as entries
        join public.hosts as hosts on hosts.id = entries.host_id
        where hosts.server_id = p_server_id
          and hosts.enabled
          and entries.received_at >= v_retention_cutoff
          and entries.observed_at >= v_window_cutoff
          and (p_source_name is null or entries.source_name = p_source_name)
          and (p_level is null or entries.level = p_level)
          and (v_query is null or position(lower(v_query) in lower(entries.message)) > 0)
        order by entries.id desc
        limit p_limit
      )
      select
        latest.id,
        latest.server_id,
        latest.display_name,
        latest.source_type,
        latest.source_name,
        latest.observed_at,
        latest.level,
        latest.message,
        latest.received_at
      from latest
      order by latest.id;
    return;
  end if;

  return query
    select
      entries.id,
      hosts.server_id,
      hosts.display_name,
      entries.source_type,
      entries.source_name,
      entries.observed_at,
      entries.level,
      entries.message,
      entries.received_at
    from public.console_log_entries as entries
    join public.hosts as hosts on hosts.id = entries.host_id
    where hosts.server_id = p_server_id
      and hosts.enabled
      and entries.id > p_after_id
      and entries.received_at >= v_retention_cutoff
      and entries.observed_at >= v_window_cutoff
      and (p_source_name is null or entries.source_name = p_source_name)
      and (p_level is null or entries.level = p_level)
      and (v_query is null or position(lower(v_query) in lower(entries.message)) > 0)
    order by entries.id
    limit p_limit;
end;
$$;

revoke all on function public.get_console_logs_v2(text, text, text, text, integer, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.get_console_logs_v2(text, text, text, text, integer, bigint, integer)
  to service_role;

comment on function public.get_console_logs_v2(text, text, text, text, integer, bigint, integer) is
  '認証済みServer UI向けRead RPC v2。24時間Retention内で5m/15m/1h/6h/24hのallowlist windowとbounded keyset取得を提供する。';
