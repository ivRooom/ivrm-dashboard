alter table public.hosts
  add column if not exists enabled boolean not null default true;

alter table public.agent_heartbeats
  add column if not exists request_nonce text,
  add column if not exists body_sha256 text;

update public.agent_heartbeats
set request_nonce = encode(gen_random_bytes(16), 'hex')
where request_nonce is null;

update public.agent_heartbeats
set body_sha256 = repeat('0', 64)
where body_sha256 is null;

alter table public.agent_heartbeats
  alter column request_nonce set not null,
  alter column body_sha256 set not null;

create unique index if not exists agent_heartbeats_request_nonce_uidx
  on public.agent_heartbeats (request_nonce);

alter table public.agent_heartbeats
  drop constraint if exists agent_heartbeats_request_nonce_format;

alter table public.agent_heartbeats
  add constraint agent_heartbeats_request_nonce_format
  check (request_nonce ~ '^[a-f0-9]{32}$');

alter table public.agent_heartbeats
  drop constraint if exists agent_heartbeats_body_sha256_format;

alter table public.agent_heartbeats
  add constraint agent_heartbeats_body_sha256_format
  check (body_sha256 ~ '^[a-f0-9]{64}$');

comment on column public.hosts.enabled is 'AgentからのHeartbeat受信を許可するか';
comment on column public.agent_heartbeats.request_nonce is '同一リクエストの再送を拒否するための一意Nonce';
comment on column public.agent_heartbeats.body_sha256 is '署名検証済みリクエスト本文のSHA-256';
