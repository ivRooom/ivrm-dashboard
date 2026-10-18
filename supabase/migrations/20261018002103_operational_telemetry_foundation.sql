-- Prepared only: no producers/sources are seeded and no production application.
create schema if not exists ivrm_telemetry;
revoke all on schema ivrm_telemetry from public, anon, authenticated, service_role;

create table ivrm_telemetry.producers (
  id text primary key check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  enabled boolean not null default false,
  requests_per_minute integer not null default 60 check (requests_per_minute between 1 and 600),
  events_per_minute integer not null default 2000 check (events_per_minute between 1 and 60000),
  max_events integer not null default 10000 check (max_events between 1 and 1000000),
  max_batches integer not null default 10000 check (max_batches between 1 and 1000000),
  max_payload_bytes bigint not null default 67108864 check (max_payload_bytes between 65536 and 1073741824),
  window_at timestamptz not null default '-infinity',
  request_count integer not null default 0,
  window_events integer not null default 0,
  event_count integer not null default 0,
  batch_count integer not null default 0,
  payload_bytes bigint not null default 0
);
create table ivrm_telemetry.sources (
  producer_id text not null references ivrm_telemetry.producers(id),
  source_id text not null,
  service_id text not null,
  source_type text not null,
  provider text not null,
  resource_id text,
  host_id text,
  enabled boolean not null default false,
  allowed_kinds text[] not null default array['log'],
  allow_actor boolean not null default false,
  allowed_ip_provenance text[] not null default array[]::text[],
  primary key (producer_id, source_id)
);
create table ivrm_telemetry.nonces (
  producer_id text not null references ivrm_telemetry.producers(id),
  nonce text not null,
  expires_at timestamptz not null,
  primary key (producer_id, nonce)
);
create index telemetry_nonce_expiry on ivrm_telemetry.nonces(producer_id, expires_at);
create table ivrm_telemetry.batches (
  producer_id text not null references ivrm_telemetry.producers(id),
  batch_id uuid not null,
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  receipt jsonb not null,
  received_at timestamptz not null default clock_timestamp(),
  primary key (producer_id, batch_id)
);
create table ivrm_telemetry.events (
  producer_id text not null references ivrm_telemetry.producers(id),
  event_id uuid not null,
  event_sha256 text not null check (event_sha256 ~ '^[a-f0-9]{64}$'),
  source_id text not null,
  observed_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  event jsonb not null,
  archived_at timestamptz,
  primary key (producer_id, event_id),
  foreign key (producer_id, source_id) references ivrm_telemetry.sources(producer_id, source_id)
);
create index telemetry_events_archive on ivrm_telemetry.events(received_at) where archived_at is null;

alter table ivrm_telemetry.producers enable row level security;
alter table ivrm_telemetry.producers force row level security;
alter table ivrm_telemetry.sources enable row level security;
alter table ivrm_telemetry.sources force row level security;
alter table ivrm_telemetry.nonces enable row level security;
alter table ivrm_telemetry.nonces force row level security;
alter table ivrm_telemetry.batches enable row level security;
alter table ivrm_telemetry.batches force row level security;
alter table ivrm_telemetry.events enable row level security;
alter table ivrm_telemetry.events force row level security;
revoke all on all tables in schema ivrm_telemetry from public, anon, authenticated, service_role;

-- Public facade only for server-side PostgREST. Definer is necessary to keep
-- every table private even to the service role. Never grant to browser roles.
create function public.ingest_operational_telemetry_v1(
  p_producer_id text, p_batch_id uuid, p_nonce text, p_body_sha256 text, p_events jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
set lock_timeout = '2s' set statement_timeout = '5s'
as $$
declare
  p ivrm_telemetry.producers%rowtype;
  s ivrm_telemetry.sources%rowtype;
  old_batch ivrm_telemetry.batches%rowtype;
  old_digest text;
  item jsonb;
  e jsonb;
  v_now timestamptz;
  new_events integer := 0;
  duplicates integer := 0;
  new_bytes bigint := 0;
  result jsonb;
begin
  if p_producer_id is null or p_batch_id is null or p_nonce is null or p_nonce !~ '^[a-f0-9]{32}$'
    or p_body_sha256 is null or p_body_sha256 !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status',400,'code','invalid_payload');
  end if;
  if jsonb_typeof(p_events) is distinct from 'array' then return jsonb_build_object('status',400,'code','invalid_payload'); end if;
  if jsonb_array_length(p_events) not between 1 and 100 or octet_length(p_events::text) > 131072 then
    return jsonb_build_object('status',400,'code','invalid_payload');
  end if;
  -- Lock before reading counters/checking duplicates: all same-producer requests
  -- serialize, including requests arriving from different app instances.
  select * into p from ivrm_telemetry.producers where id = p_producer_id and enabled for update;
  if not found then return jsonb_build_object('status',403,'code','source_not_allowed'); end if;
  v_now := clock_timestamp();
  if p.window_at <= v_now - interval '1 minute' then
    update ivrm_telemetry.producers set window_at=v_now,request_count=0,window_events=0 where id=p.id;
    p.request_count := 0; p.window_events := 0;
  end if;
  if p.request_count >= p.requests_per_minute then return jsonb_build_object('status',429,'code','rate_limited'); end if;
  update ivrm_telemetry.producers set request_count=request_count+1 where id=p.id;
  delete from ivrm_telemetry.nonces where producer_id=p.id and expires_at < v_now;
  if exists(select 1 from ivrm_telemetry.nonces where producer_id=p.id and nonce=p_nonce) then
    return jsonb_build_object('status',401,'code','authentication_failed');
  end if;
  insert into ivrm_telemetry.nonces values(p.id,p_nonce,v_now+interval '600 seconds');
  select * into old_batch from ivrm_telemetry.batches where producer_id=p.id and batch_id=p_batch_id;
  if found then
    if old_batch.body_sha256 <> p_body_sha256 then return jsonb_build_object('status',409,'code','content_conflict'); end if;
    return jsonb_build_object('status',200,'receipt',old_batch.receipt || '{"replayed":true}'::jsonb);
  end if;
  if (select count(distinct (entry->'event'->>'eventId')::uuid) from jsonb_array_elements(p_events) entry) <> jsonb_array_length(p_events) then
    return jsonb_build_object('status',400,'code','invalid_payload');
  end if;
  -- Complete validation and all conflicts/capacity checks before writing events.
  for item in select value from jsonb_array_elements(p_events) loop
    e := item->'event';
    if item->>'digest' is null or item->>'digest' !~ '^[a-f0-9]{64}$' or
      jsonb_typeof(e) is distinct from 'object' or e->>'eventId' is null or e->>'observedAt' is null or
      e->>'message' is null or char_length(e->>'message') not between 1 and 2048 then
      return jsonb_build_object('status',400,'code','invalid_payload');
    end if;
    if (e->>'observedAt')::timestamptz < v_now-interval '7 days' or (e->>'observedAt')::timestamptz > v_now+interval '30 seconds' then
      return jsonb_build_object('status',400,'code','invalid_payload');
    end if;
    select * into s from ivrm_telemetry.sources where producer_id=p.id and source_id=e->'source'->>'sourceId' and enabled for share;
    if not found then return jsonb_build_object('status',403,'code','source_not_allowed'); end if;
    if (e->'source'->>'serviceId') is distinct from s.service_id or (e->'source'->>'type') is distinct from s.source_type or
      (e->'source'->>'provider') is distinct from s.provider or (e->'source'->>'hostId') is distinct from s.host_id or
      (e->'source'->>'resourceId') is distinct from s.resource_id or not coalesce((e->>'kind')=any(s.allowed_kinds),false) or
      (e ? 'actor' and not s.allow_actor) or
      (e ? 'clientIp' and not coalesce((e->'clientIp'->>'provenance')=any(s.allowed_ip_provenance),false)) then
      return jsonb_build_object('status',403,'code','source_not_allowed');
    end if;
    select event_sha256 into old_digest from ivrm_telemetry.events where producer_id=p.id and event_id=(e->>'eventId')::uuid;
    if found then
      if old_digest <> item->>'digest' then return jsonb_build_object('status',409,'code','content_conflict'); end if;
      duplicates := duplicates+1;
    else new_events := new_events+1; new_bytes := new_bytes+octet_length(e::text);
    end if;
  end loop;
  if p.event_count+new_events > p.max_events or p.batch_count+1 > p.max_batches or
    p.payload_bytes+new_bytes > p.max_payload_bytes or p.window_events+new_events > p.events_per_minute then
    return jsonb_build_object('status',429,'code','rate_limited');
  end if;
  insert into ivrm_telemetry.events(producer_id,event_id,event_sha256,source_id,observed_at,received_at,event)
    select p.id,(value->'event'->>'eventId')::uuid,value->>'digest',value->'event'->'source'->>'sourceId',
      (value->'event'->>'observedAt')::timestamptz,v_now,value->'event'
    from jsonb_array_elements(p_events)
    on conflict (producer_id,event_id) do nothing;
  result := jsonb_build_object('accepted',true,'batchId',p_batch_id,'replayed',false,'acceptedEvents',new_events,'duplicateEvents',duplicates);
  insert into ivrm_telemetry.batches(producer_id,batch_id,body_sha256,receipt,received_at) values(p.id,p_batch_id,p_body_sha256,result,v_now);
  update ivrm_telemetry.producers set event_count=event_count+new_events,batch_count=batch_count+1,
    payload_bytes=payload_bytes+new_bytes,window_events=window_events+new_events where id=p.id;
  return jsonb_build_object('status',202,'receipt',result);
end;
$$;
revoke all on function public.ingest_operational_telemetry_v1(text,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_operational_telemetry_v1(text,uuid,text,text,jsonb) to service_role;
