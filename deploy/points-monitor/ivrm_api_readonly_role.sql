-- =====================================================================
-- TARGET DATABASE: ivrm_api  (NOT ivrm_dashboard — do not run this
-- file against ivrm_dashboard, and do not add it to either repo's
-- auto-applied migration chain.)
--
-- Purpose: create the least-privilege read-only role used by the
-- ivrm-dashboard point-grant liveness monitor (ivrm-dashboard Issue
-- #221, deploy/systemd/ivrm-dash-points-check.sh). The checker counts,
-- for the current JST day only:
--   * ivrm_api.login_bonus_claims rows (via claim_date_jst)
--   * ivrm_api.point_transactions rows with type = 'earn'
--   * ivrm_api.xp_events rows (via received_at)
--
-- PRODUCTION APPLICATION IS APPROVAL-GATED (Kanata). This file is
-- prepared in the repo only; nothing here has been applied.
--
-- Before applying:
--   1. Connect to the ivrm_api database on the DB host as a superuser.
--   2. Run this file.
--   3. Set the role password through a secure channel, e.g.
--        \password ivrm_dashboard_points_ro
--      and store it ONLY in /etc/ivrm-dashboard-timers/
--      points-api.pgservice (root, 600) on the DB host, in the
--      [points-api] service section. Never commit the password.
--   4. Flip public.point_grant_monitor_config.enabled to true in
--      ivrm_dashboard only after the checker timer is installed and
--      'ok' observations are arriving.
-- =====================================================================

begin;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'ivrm_dashboard_points_ro') then
    raise exception 'role ivrm_dashboard_points_ro already exists; aborting';
  end if;
  if current_database() <> 'ivrm_api' then
    raise exception 'this file must run against the ivrm_api database (current: %)', current_database();
  end if;
end;
$$;

create role ivrm_dashboard_points_ro
  login nosuperuser nocreatedb nocreaterole noreplication
  connection limit 4;

comment on role ivrm_dashboard_points_ro is
  'ivrm-dashboard point-grant liveness monitor (Issue #221): read-only daily counts of login_bonus_claims, point_transactions (earn) and xp_events.';

-- Hard bound every statement the monitor can run.
alter role ivrm_dashboard_points_ro set statement_timeout = '15s';

grant connect on database ivrm_api to ivrm_dashboard_points_ro;
grant usage on schema ivrm_api to ivrm_dashboard_points_ro;
grant select on ivrm_api.login_bonus_claims to ivrm_dashboard_points_ro;
grant select on ivrm_api.point_transactions to ivrm_dashboard_points_ro;
grant select on ivrm_api.xp_events to ivrm_dashboard_points_ro;

commit;

-- Verification (read-only, run after setting the password):
--   \du ivrm_dashboard_points_ro
--   -- as the role (via the service file):
--   --   PGSERVICEFILE=/etc/ivrm-dashboard-timers/points-api.pgservice
--   --   PGSERVICE=points-api psql -c '\z ivrm_api.point_transactions'
--   -- has_table_privilege('ivrm_dashboard_points_ro',
--   --   'ivrm_api.point_transactions', 'SELECT')        -> true
--   -- has_table_privilege('ivrm_dashboard_points_ro',
--   --   'ivrm_api.point_transactions', 'INSERT')        -> false
--
-- Rollback:
--   revoke select on ivrm_api.login_bonus_claims,
--     ivrm_api.point_transactions, ivrm_api.xp_events
--     from ivrm_dashboard_points_ro;
--   revoke usage on schema ivrm_api from ivrm_dashboard_points_ro;
--   revoke connect on database ivrm_api from ivrm_dashboard_points_ro;
--   drop role ivrm_dashboard_points_ro;
