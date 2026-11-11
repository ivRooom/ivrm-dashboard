# Dashboard PostgREST stack (PG17)

The console (Vercel) talks to Supabase exclusively through PostgREST
(`/rest/v1/rpc/*` and `/rest/v1/<table>`) with the service role key. To move
the database to the Lightsail PG17 cluster without rewriting the console, a
stock PostgREST serves the `ivrm_dashboard` database:

- Container `ivrm-postgrest` (postgrest/postgrest:v12.2.3) on the app host,
  joined to the `ivrm-runtime-edge` docker network.
- The runtime Caddy routes `api.ivrm.jp/dash/rest/v1/*` to it, stripping the
  `/dash/rest/v1` prefix (the same shape Supabase's gateway produces), so the
  console's `SUPABASE_URL` is `https://api.ivrm.jp/dash`.
- Auth mirrors Supabase: PostgREST validates HS256 JWTs with
  `PGRST_JWT_SECRET`; the console's `SUPABASE_SERVICE_ROLE_KEY` is a
  long-lived JWT with `role: ivrm_dashboard_service` (BYPASSRLS, full grants).
  The anonymous role `ivrm_dashboard_anon` has no grants, so unauthenticated
  requests fail closed (401). Connections authenticate as
  `ivrm_dashboard_authenticator` (NOINHERIT) over TLS verify-full.
- The companion `dispatch-worker` service replaces the notification-dispatch
  Edge Function (see `apps/dispatch-worker/`).

Secrets live host-side only: `/opt/ivrm/dashboard/.env` (JWT secret + DB URI)
and `/opt/ivrm/dashboard/service-jwt` (the minted service token), both
root-owned 600. The service JWT was pasted into the Vercel project's
`SUPABASE_SERVICE_ROLE_KEY` by the owner at cutover; it is never committed.

## Files

`/opt/ivrm/dashboard/docker-compose.yml` (canonical copy: this directory),
`/opt/ivrm/dashboard/worker/` (build context for the worker image).
