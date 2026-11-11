# ivrm-dispatch-worker

Polling replacement for the Supabase Edge Function `notification-dispatch`.

On Supabase, dispatch was driven by pg_cron -> `kick_notification_dispatch_v1()`
-> pg_net -> Edge Function. On the PG17 stack there is no pg_cron/pg_net, so
this worker runs the same claim/deliver/complete cycle directly against
PostgreSQL every minute:

- `claim_notification_outbox_v1` / `claim_notification_deliveries_v1`
- `notification_delivery_block_reason_v1` / `suppress_notification_delivery_v1`
- `complete_notification_delivery_v1` (+ event-delivery variants)
- `mark_notification_dispatch_v1`

Embed payloads, error codes (`discord_http_<status>`, `dispatcher_row_error`,
`channel_unconfigured`, `partial_claim_failure`, `partial_delivery_failure`)
and the batch size (10 per claim) mirror the Edge Function.

## Identity

The connection authenticates as the PostgREST authenticator role and assumes
`ivrm_dashboard_service` (BYPASSRLS), mirroring the Edge Function's
service_role identity. The claim/complete RPCs are SECURITY DEFINER; direct
table reads (the `notification_channels` gate) need the bypass.

## Configuration

| Env | Meaning |
| --- | --- |
| `DASHBOARD_DATABASE_URL_FILE` | File with the authenticator connection URL |
| `DASHBOARD_PG_CA_FILE` | PG17 CA certificate (TLS verify-full, servername `ivrm-db-postgres.internal`) |
| `DASHBOARD_PG_ROLE` | Role to assume after connect (default `ivrm_dashboard_service`) |
| `DISCORD_WEBHOOK_URL_FILE` | File with the Discord webhook URL. While unset/invalid the worker only marks `channel_unconfigured` and never claims. |
| `WORKER_INTERVAL_MS` | Poll interval (default 60000) |
| `WORKER_RUN_ONCE` | `1` = run one cycle and exit (testing) |
| `WORKER_ALLOW_CUSTOM_WEBHOOK` | `1` = skip the Discord URL shape check (testing only) |
| `DISCORD_MENTION_ROLE_ID` | Discord role id mentioned on critical notifications (see Mentions). Unset/invalid = mentions disabled. |

## Mentions

Monitor notifications (the legacy outbox path) mention the configured role
only when a human needs to act now (Issue #184):

- `opened` with severity `critical`
- `escalated` (any severity — in practice the rank only rises to critical)
- OOM kills (`signal_key` ending in `:oom_killed`)

Warnings, recoveries, and re-delivery attempts never mention. The mention is
sent as message `content` (`<@&role-id>`) with
`allowed_mentions: { parse: [], roles: [role-id] }`, so nothing else in the
payload can trigger a ping. Status-event deliveries (incidents, maintenance,
announcements) are a separate stream and never mention.

## Deployment

Runs as the `dispatch-worker` service of the dashboard stack
(`deploy/postgrest/docker-compose.yml`) on the app host.
