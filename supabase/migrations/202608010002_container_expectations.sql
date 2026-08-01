create table if not exists public.container_expectations (
  host_id uuid not null references public.hosts(id) on delete cascade,
  container_name text not null check (
    container_name ~ '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$'
  ),
  expected_state text not null check (
    expected_state in ('running', 'stopped', 'absent')
  ),
  maintenance_mode boolean not null default false,
  maintenance_reason text check (
    maintenance_reason is null or char_length(maintenance_reason) <= 200
  ),
  maintenance_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (host_id, container_name)
);

create index if not exists container_expectations_maintenance_idx
  on public.container_expectations (maintenance_mode, maintenance_until)
  where maintenance_mode = true;

alter table public.container_expectations enable row level security;

revoke all on table public.container_expectations from anon, authenticated;
grant select on table public.container_expectations to service_role;

drop policy if exists "deny_public_container_expectations_access"
  on public.container_expectations;
create policy "deny_public_container_expectations_access"
on public.container_expectations
as restrictive
for all
to anon, authenticated
using (false)
with check (false);

insert into public.container_expectations (
  host_id,
  container_name,
  expected_state
)
select
  hosts.id,
  expectations.container_name,
  expectations.expected_state
from public.hosts
cross join (
  values
    ('mc-main', 'running'),
    ('mc-resource', 'stopped'),
    ('mc-resource-router', 'running')
) as expectations(container_name, expected_state)
where hosts.server_id = 'oci-minecraft-01'
on conflict (host_id, container_name)
do update set
  expected_state = excluded.expected_state,
  updated_at = now();

comment on table public.container_expectations is
  'Dockerコンテナの期待状態と読み取り専用メンテナンス設定';
comment on column public.container_expectations.expected_state is
  'running=稼働期待、stopped=停止期待、absent=未作成期待';
comment on column public.container_expectations.maintenance_until is
  'NULLの場合は解除されるまで、値がある場合は期限内だけメンテナンス扱い';
