create table if not exists public.reliability_slo_policies (
  service_id text primary key,
  target_percent numeric(7,4),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint reliability_slo_policies_service_id_check
    check (service_id in ('overall', 'host', 'container', 'backup')),
  constraint reliability_slo_policies_target_percent_check
    check (target_percent is null or (target_percent > 0 and target_percent < 100)),
  constraint reliability_slo_policies_enabled_target_check
    check (not enabled or target_percent is not null)
);

alter table public.reliability_slo_policies enable row level security;

revoke all on table public.reliability_slo_policies from anon, authenticated;
grant select, update on table public.reliability_slo_policies to service_role;

insert into public.reliability_slo_policies (service_id, target_percent, enabled)
values
  ('overall', null, false),
  ('host', null, false),
  ('container', null, false),
  ('backup', null, false)
on conflict (service_id) do nothing;

comment on table public.reliability_slo_policies is
  'Explicit SLO policy registry for Reliability Center. Targets are intentionally unconfigured by default.';
comment on column public.reliability_slo_policies.target_percent is
  'Availability objective percentage. Null means the target is not configured.';
comment on column public.reliability_slo_policies.enabled is
  'Whether the configured target participates in Error Budget calculations.';
