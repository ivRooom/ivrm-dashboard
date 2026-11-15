-- =====================================================================
-- TARGET DATABASE: ivrm_api  (NOT ivrm_dashboard — do not run this
-- file against ivrm_dashboard, and do not add it to either repo's
-- auto-applied migration chain.)
--
-- Purpose: extend the existing ivrm-dashboard read-only role
-- (ivrm_dashboard_points_ro, created for the point-grant liveness
-- monitor, ivrm-dashboard Issue #221) with SELECT on the three quiz
-- stock tables read by the quiz stock checker (ivrm-web Issue #749,
-- deploy/systemd/ivrm-dash-quiz-check.sh). The checker reuses the
-- same role and the same libpq service file
-- (/etc/ivrm-dashboard-timers/points-api.pgservice); no new role and
-- no new secret are created.
--
-- The checker counts, for the current and next JST slot days only:
--   * ivrm_api.daily_questions rows by date_jst / slot / status
--   * ivrm_api.daily_login_quizzes approved candidates
--     (scheduled_date null or the target day)
--   * ivrm_api.daily_login_quiz_publications rows fixed to
--     quiz_id = 'none'
-- It never writes to ivrm_api and never calls the publication
-- materializer.
--
-- PRODUCTION APPLICATION IS APPROVAL-GATED (Kanata). This file is
-- prepared in the repo only; nothing here has been applied.
--
-- Before applying:
--   1. Connect to the ivrm_api database on the DB host as a superuser.
--   2. Run this file.
--   3. Install ivrm-dash-quiz-check on the DB host and confirm 'ok'
--      observations arrive in ivrm_dashboard.quiz_stock_observations.
--   4. Flip public.quiz_stock_monitor_config.enabled to true in
--      ivrm_dashboard only after step 3 is confirmed.
-- =====================================================================

begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ivrm_dashboard_points_ro') then
    raise exception 'role ivrm_dashboard_points_ro does not exist; apply deploy/points-monitor/ivrm_api_readonly_role.sql first';
  end if;
  if current_database() <> 'ivrm_api' then
    raise exception 'this file must run against the ivrm_api database (current: %)', current_database();
  end if;
end;
$$;

grant select on ivrm_api.daily_questions to ivrm_dashboard_points_ro;
grant select on ivrm_api.daily_login_quizzes to ivrm_dashboard_points_ro;
grant select on ivrm_api.daily_login_quiz_publications to ivrm_dashboard_points_ro;

-- daily_questions has row level security enabled with FORCE and, at
-- the time of the production application, no policies at all. RLS is
-- default-deny, so the GRANT above alone left every row invisible to
-- the read-only role (the checker would have counted 0 ready rows and
-- false-fired a stock-out). The production application on 2026-11-15
-- therefore also added this SELECT-only policy; it is recorded here
-- so the repo matches production. The other two tables have no
-- policies in production and need none. Idempotent: safe to re-run.
drop policy if exists ivrm_dashboard_points_ro_select on ivrm_api.daily_questions;
create policy ivrm_dashboard_points_ro_select on ivrm_api.daily_questions
  for select to ivrm_dashboard_points_ro
  using (true);

comment on role ivrm_dashboard_points_ro is
  'ivrm-dashboard monitors (Issues #221 / ivrm-web #749): read-only counts of login_bonus_claims, point_transactions (earn), xp_events, daily_questions, daily_login_quizzes and daily_login_quiz_publications in ivrm_api.';

commit;

-- Verification (read-only, run after applying):
--   -- as the role (via the service file):
--   --   PGSERVICEFILE=/etc/ivrm-dashboard-timers/points-api.pgservice
--   --   PGSERVICE=points-api psql -c '\z ivrm_api.daily_questions'
--   -- has_table_privilege('ivrm_dashboard_points_ro',
--   --   'ivrm_api.daily_questions', 'SELECT')             -> true
--   -- has_table_privilege('ivrm_dashboard_points_ro',
--   --   'ivrm_api.daily_questions', 'INSERT')             -> false
--   -- has_table_privilege('ivrm_dashboard_points_ro',
--   --   'ivrm_api.daily_login_quiz_publications', 'SELECT') -> true
--   -- pg_policies: ivrm_dashboard_points_ro_select exists on
--   --   ivrm_api.daily_questions (PERMISSIVE, cmd SELECT, roles
--   --   {ivrm_dashboard_points_ro}, qual 'true', with_check null)
--
-- Rollback:
--   drop policy ivrm_dashboard_points_ro_select
--     on ivrm_api.daily_questions;
--   revoke select on ivrm_api.daily_questions,
--     ivrm_api.daily_login_quizzes,
--     ivrm_api.daily_login_quiz_publications
--     from ivrm_dashboard_points_ro;
