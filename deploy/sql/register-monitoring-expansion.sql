-- Issue #184: monitoring expansion registrations.
-- Run once against PG17 `ivrm_dashboard` at each host's install gate,
-- after the host's agent is heartbeating (see docs/monitoring-expansion.md).
-- Idempotent: safe to re-run.

begin;

-- lightsail-herta: row exists since the early rollout but was never enabled.
update public.hosts
set enabled = true, updated_at = now()
where server_id = 'lightsail-herta';

-- ivrm-db-postgres-01: new host row (heartbeat-only monitoring).
insert into public.hosts (server_id, display_name, provider, environment, enabled)
values ('ivrm-db-postgres-01', 'AWS Lightsail / DB (PG17)', 'aws', 'production', true)
on conflict (server_id) do nothing;

-- aws-app-01 container expectations (all long-running services).
insert into public.container_expectations (host_id, container_name, expected_state)
select h.id, c.name, 'running'
from public.hosts h
cross join (values
  ('ivrm-admin'), ('ivrm-ai'), ('ivrm-api'), ('ivrm-cloudflared'),
  ('ivrm-contact'), ('ivrm-dispatch-worker'), ('ivrm-home'), ('ivrm-member'),
  ('ivrm-postgrest'), ('ivrm-release-registry'), ('ivrm-runtime-caddy'),
  ('ivrm-runtime-health'), ('release-web-1')
) as c(name)
where h.server_id = 'aws-app-01'
on conflict do nothing;

-- lightsail-herta container expectations.
-- herta-migrator-1 is a oneshot: stopped is normal, hence 'on-demand'
-- (Issue #184 P1: state is never a violation; health/exit-code are only
-- evaluated while it is running).
insert into public.container_expectations (host_id, container_name, expected_state)
select h.id, c.name, c.expected
from public.hosts h
cross join (values
  ('herta-api-1', 'running'), ('herta-bot-1', 'running'),
  ('herta-caddy-1', 'running'), ('herta-nginx-1', 'running'),
  ('herta-redis-1', 'running'), ('herta-studio-1', 'running'),
  ('herta-worker-1', 'running'), ('herta-migrator-1', 'on-demand')
) as c(name, expected)
where h.server_id = 'lightsail-herta'
on conflict do nothing;

commit;
