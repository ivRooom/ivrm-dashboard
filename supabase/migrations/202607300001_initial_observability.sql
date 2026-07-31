create extension if not exists pgcrypto;

create table if not exists public.hosts (
  id uuid primary key default gen_random_uuid(),
  server_id text not null unique,
  display_name text not null,
  provider text not null check (provider in ('oci', 'aws', 'other')),
  environment text not null default 'production',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_heartbeats (
  id bigint generated always as identity primary key,
  host_id uuid not null references public.hosts(id) on delete cascade,
  agent_version text not null,
  received_at timestamptz not null default now(),
  sent_at timestamptz not null,
  cpu_count integer not null check (cpu_count > 0),
  memory_total_bytes bigint not null check (memory_total_bytes >= 0),
  memory_available_bytes bigint not null check (memory_available_bytes >= 0),
  disk_total_bytes bigint not null check (disk_total_bytes >= 0),
  disk_available_bytes bigint not null check (disk_available_bytes >= 0),
  load_average_1 double precision not null,
  load_average_5 double precision not null,
  load_average_15 double precision not null,
  uptime_seconds double precision not null check (uptime_seconds >= 0)
);

create index if not exists agent_heartbeats_host_received_idx
  on public.agent_heartbeats (host_id, received_at desc);

alter table public.hosts enable row level security;
alter table public.agent_heartbeats enable row level security;

comment on table public.hosts is 'IVRM Agentが稼働する監視対象ホスト';
comment on table public.agent_heartbeats is 'Agentから受信した読み取り専用ホストメトリクス';
