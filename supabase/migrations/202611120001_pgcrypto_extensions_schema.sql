-- Restore pgcrypto in the extensions schema for PG17 (ivrm_dashboard).
--
-- The Supabase-era audit functions (append_audit_log and its callers such as
-- create_discord_console_session) carry SET search_path = public, extensions
-- and call digest(), which Supabase provided via pgcrypto in the extensions
-- schema. The PG17 migration did not install pgcrypto, so every audited
-- mutation failed with "function digest(bytea, unknown) does not exist" and
-- console Discord login returned configuration_error.
--
-- Applied to production on 2026-11-12 with the owner's approval, after
-- rollback-transaction verification of append_audit_log /
-- create_discord_console_session / resolve_discord_console_session and a
-- live callback probe that wrote DISCORD_LOGIN_DENIED to audit_logs.
-- This file records that change in the repository; it is idempotent.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO
  ivrm_dashboard_owner,
  ivrm_dashboard_service,
  ivrm_dashboard_runtime,
  ivrm_dashboard_authenticator,
  ivrm_dashboard_anon;
