create table public.console_log_ingest_requests (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  reported_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  request_nonce text not null,
  body_sha256 text not null,
  entry_count smallint not null,
  constraint console_log_ingest_requests_nonce_format_check
    check (request_nonce ~ '^[a-f0-9]{32}$'),
  constraint console_log_ingest_requests_body_sha256_format_check
    check (body_sha256 ~ '^[a-f0-9]{64}$'),
  constraint console_log_ingest_requests_entry_count_check
    check (entry_count between 1 and 120),
  constraint console_log_ingest_requests_host_nonce_key
    unique (host_id, request_nonce)
);

create index console_log_ingest_requests_host_received_idx
  on public.console_log_ingest_requests (host_id, received_at desc, id desc);
create index console_log_ingest_requests_received_idx
  on public.console_log_ingest_requests (received_at, id);

create table public.console_log_entries (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  event_id text not null,
  source_type text not null,
  source_name text not null,
  observed_at timestamptz not null,
  level text not null,
  message text not null,
  received_at timestamptz not null default clock_timestamp(),
  constraint console_log_entries_host_event_key unique (host_id, event_id),
  constraint console_log_entries_event_id_format_check
    check (event_id ~ '^[a-f0-9]{64}$'),
  constraint console_log_entries_source_check check (
    (source_type = 'container' and source_name in (
      'mc-main', 'mc-block', 'ivrm-velocity', 'mc-resource', 'mc-resource-router'
    ))
    or (source_type = 'systemd' and source_name = 'ivrm-agent')
  ),
  constraint console_log_entries_level_check
    check (level in ('debug', 'info', 'warning', 'error', 'critical')),
  constraint console_log_entries_message_length_check
    check (char_length(message) between 1 and 2048 and octet_length(message) <= 8192),
  constraint console_log_entries_single_line_check
    check (position(chr(10) in message) = 0 and position(chr(13) in message) = 0)
);

create index console_log_entries_host_observed_idx
  on public.console_log_entries (host_id, observed_at desc, id desc);
create index console_log_entries_host_source_observed_idx
  on public.console_log_entries (host_id, source_name, observed_at desc, id desc);
create index console_log_entries_received_idx
  on public.console_log_entries (received_at, id);

alter table public.console_log_ingest_requests enable row level security;
alter table public.console_log_ingest_requests force row level security;
alter table public.console_log_entries enable row level security;
alter table public.console_log_entries force row level security;

revoke all on table public.console_log_ingest_requests
  from public, anon, authenticated, service_role;
revoke all on table public.console_log_entries
  from public, anon, authenticated, service_role;

create or replace function public.console_log_entry_is_valid_v1(
  p_entry jsonb,
  p_reported_at timestamptz
)
returns boolean
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_event_id text;
  v_source_type text;
  v_source_name text;
  v_observed_at timestamptz;
  v_level text;
  v_message text;
begin
  if p_entry is null
    or jsonb_typeof(p_entry) <> 'object'
    or not (p_entry ? 'eventId')
    or not (p_entry ? 'sourceType')
    or not (p_entry ? 'sourceName')
    or not (p_entry ? 'observedAt')
    or not (p_entry ? 'level')
    or not (p_entry ? 'message')
    or exists (
      select 1
      from jsonb_object_keys(p_entry) as keys(key)
      where keys.key not in ('eventId', 'sourceType', 'sourceName', 'observedAt', 'level', 'message')
    ) then
    return false;
  end if;

  begin
    v_event_id := p_entry->>'eventId';
    v_source_type := p_entry->>'sourceType';
    v_source_name := p_entry->>'sourceName';
    v_observed_at := (p_entry->>'observedAt')::timestamptz;
    v_level := p_entry->>'level';
    v_message := p_entry->>'message';
  exception when others then
    return false;
  end;

  return v_event_id ~ '^[a-f0-9]{64}$'
    and (
      (v_source_type = 'container' and v_source_name in (
        'mc-main', 'mc-block', 'ivrm-velocity', 'mc-resource', 'mc-resource-router'
      ))
      or (v_source_type = 'systemd' and v_source_name = 'ivrm-agent')
    )
    and v_observed_at >= p_reported_at - interval '5 minutes'
    and v_observed_at <= p_reported_at + interval '5 minutes'
    and v_level in ('debug', 'info', 'warning', 'error', 'critical')
    and char_length(v_message) between 1 and 2048
    and octet_length(v_message) <= 8192
    and position(chr(10) in v_message) = 0
    and position(chr(13) in v_message) = 0;
end;
$$;

create or replace function public.prune_console_log_rows_v1(
  p_batch_size integer default 5000
)
returns table (
  deleted_entries bigint,
  deleted_requests bigint
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted_entries bigint := 0;
  v_deleted_requests bigint := 0;
begin
  if p_batch_size is null or p_batch_size not between 100 and 20000 then
    raise exception 'console_log_retention_batch_invalid' using errcode = '22023';
  end if;

  with candidates as (
    select entries.id
    from public.console_log_entries as entries
    where entries.received_at < clock_timestamp() - interval '24 hours'
    order by entries.received_at, entries.id
    limit p_batch_size
  ), deleted as (
    delete from public.console_log_entries as entries
    using candidates
    where entries.id = candidates.id
    returning entries.id
  )
  select count(*) into v_deleted_entries from deleted;

  with candidates as (
    select requests.id
    from public.console_log_ingest_requests as requests
    where requests.received_at < clock_timestamp() - interval '24 hours'
    order by requests.received_at, requests.id
    limit p_batch_size
  ), deleted as (
    delete from public.console_log_ingest_requests as requests
    using candidates
    where requests.id = candidates.id
    returning requests.id
  )
  select count(*) into v_deleted_requests from deleted;

  return query select v_deleted_entries, v_deleted_requests;
end;
$$;

create or replace function public.ingest_console_log_report_v1(
  p_server_id text,
  p_reported_at timestamptz,
  p_request_nonce text,
  p_body_sha256 text,
  p_entries jsonb
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_host_id uuid;
  v_enabled boolean;
  v_latest_received_at timestamptz;
  v_entry jsonb;
  v_entry_count integer;
begin
  if p_server_id is null
    or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
    or p_reported_at is null
    or abs(extract(epoch from (clock_timestamp() - p_reported_at))) > 300
    or p_request_nonce is null
    or p_request_nonce !~ '^[a-f0-9]{32}$'
    or p_body_sha256 is null
    or p_body_sha256 !~ '^[a-f0-9]{64}$'
    or p_entries is null
    or jsonb_typeof(p_entries) <> 'array' then
    return 'invalid_payload';
  end if;

  v_entry_count := jsonb_array_length(p_entries);
  if v_entry_count < 1 or v_entry_count > 120 then
    return 'invalid_payload';
  end if;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    if not public.console_log_entry_is_valid_v1(v_entry, p_reported_at) then
      return 'invalid_payload';
    end if;
  end loop;

  if (
    select count(*) <> count(distinct value->>'eventId')
    from jsonb_array_elements(p_entries)
  ) then
    return 'invalid_payload';
  end if;

  select hosts.id, hosts.enabled
  into v_host_id, v_enabled
  from public.hosts as hosts
  where hosts.server_id = p_server_id
  for update;

  if not found or not v_enabled then
    return 'unknown_agent';
  end if;

  select requests.received_at
  into v_latest_received_at
  from public.console_log_ingest_requests as requests
  where requests.host_id = v_host_id
  order by requests.received_at desc, requests.id desc
  limit 1;

  if v_latest_received_at is not null
    and clock_timestamp() - v_latest_received_at < interval '2 seconds' then
    return 'rate_limited';
  end if;

  begin
    insert into public.console_log_ingest_requests (
      host_id, reported_at, request_nonce, body_sha256, entry_count
    ) values (
      v_host_id, p_reported_at, p_request_nonce, p_body_sha256, v_entry_count
    );
  exception
    when unique_violation then
      return 'replayed_request';
  end;

  insert into public.console_log_entries (
    host_id, event_id, source_type, source_name, observed_at, level, message
  )
  select
    v_host_id,
    entry.value->>'eventId',
    entry.value->>'sourceType',
    entry.value->>'sourceName',
    (entry.value->>'observedAt')::timestamptz,
    entry.value->>'level',
    entry.value->>'message'
  from jsonb_array_elements(p_entries) as entry(value)
  on conflict (host_id, event_id) do nothing;

  perform public.prune_console_log_rows_v1(5000);
  return 'accepted';
end;
$$;

create or replace function public.get_console_logs_v1(
  p_server_id text,
  p_source_name text default null,
  p_level text default null,
  p_query text default null,
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
begin
  if p_server_id is null
    or p_server_id !~ '^[A-Za-z0-9._-]{1,64}$'
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
          and entries.received_at >= clock_timestamp() - interval '24 hours'
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
      and entries.received_at >= clock_timestamp() - interval '24 hours'
      and (p_source_name is null or entries.source_name = p_source_name)
      and (p_level is null or entries.level = p_level)
      and (v_query is null or position(lower(v_query) in lower(entries.message)) > 0)
    order by entries.id
    limit p_limit;
end;
$$;

revoke all on function public.console_log_entry_is_valid_v1(jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.prune_console_log_rows_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.ingest_console_log_report_v1(text, timestamptz, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_console_log_report_v1(text, timestamptz, text, text, jsonb)
  to service_role;
revoke all on function public.get_console_logs_v1(text, text, text, text, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.get_console_logs_v1(text, text, text, text, bigint, integer)
  to service_role;

comment on table public.console_log_ingest_requests is
  '署名済みLog ReportのReplay/Rate Limit管理。本文やSecretは保存しない。';
comment on table public.console_log_entries is
  'OCI側とWeb側でredact済みの短期Console Log。Read-only UI向けで24時間を超える行は取得しない。';
comment on function public.console_log_entry_is_valid_v1(jsonb, timestamptz) is
  'Console Log Entryのallowlist・型・時刻・サイズをDB変更前に検証する内部Helper。';
comment on function public.prune_console_log_rows_v1(integer) is
  'Log Report受信時に24時間を超えた短期ログとReplay記録をbounded deleteする内部Retention。';
comment on function public.ingest_console_log_report_v1(text, timestamptz, text, text, jsonb) is
  'Log Reportを原子的に検証し、重複Eventを無視して短期保存するService Role専用RPC。';
comment on function public.get_console_logs_v1(text, text, text, text, bigint, integer) is
  '認証済みServer UIがService Role経由で24時間以内のbounded Logを取得するRPC。';
