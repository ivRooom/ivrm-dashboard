-- Drop Supabase-era kick functions that are dead code on plain PostgreSQL.
--
-- STATUS: prepared only, NOT applied. Applying this migration is a
-- production DDL change and requires the Owner's explicit approval
-- (see Issue #206).
--
-- Background (verified 2026-11-12):
-- * kick_notification_dispatch_v1() posted to the notification dispatch
--   endpoint through Supabase Vault + pg_net. On PG17 the dispatch worker
--   polls the outbox itself; nothing calls this function (no pg_cron,
--   no triggers, no references from application code).
-- * kick_reliability_burn_reconcile_v1() did the same for burn-rate
--   reconciliation. The reconcile now runs from a host timer that calls
--   the console endpoint directly; reliability_burn_reconcile_state is
--   updated by that path (last_success_at advances every minute).
-- * set_reliability_burn_reconciler_v1(boolean) was the pg_cron
--   registration helper for the kick above (search_path includes the
--   cron schema, which does not exist on PG17), so it also fails if
--   called and has no callers in the repository.
--
-- Vault and pg_net do not exist on the PG17 database, so all three
-- functions would error if invoked. Removing them eliminates a latent
-- failure surface and documents that the timer/worker paths are the
-- supported mechanisms.
--
-- * configure_observability_retention_v1(boolean, int, int, int) is
--   the pg_cron registration helper for observability retention. The
--   retention job itself (run_observability_retention_v1) runs on PG17
--   and observability_retention_state is current, but no application
--   code calls this setter (only the original migration and docs
--   mention it), and its cron.* references cannot work without pg_cron.
--   Retention settings remain readable via
--   get_observability_retention_state_v2; changing them on PG17 is a
--   direct state update until a new configuration path is designed.

drop function if exists public.set_reliability_burn_reconciler_v1(boolean);
drop function if exists public.kick_reliability_burn_reconcile_v1();
drop function if exists public.kick_notification_dispatch_v1();
drop function if exists public.configure_observability_retention_v1(boolean, integer, integer, integer);
