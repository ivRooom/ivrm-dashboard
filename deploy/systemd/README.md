# ivrm-dashboard systemd timers (pg_cron replacement)

On Supabase, ten pg_cron jobs drove the observability platform. On PG17 they
are replaced by systemd timers on the database host:

| pg_cron job | Schedule | Replacement |
| --- | --- | --- |
| ivrm-maintenance-expiry-events | `* * * * *` | ivrm-dash-minutely (SQL) |
| ivrm-notification-reconcile-v1 | `* * * * *` | ivrm-dash-minutely (SQL) |
| ivrm-notification-container-reconcile-v1 | `* * * * *` | ivrm-dash-minutely (SQL) |
| ivrm-cloud-monitor-reconcile-v1 | `* * * * *` | ivrm-dash-minutely (SQL) |
| (console ingest health probe, #215) | `* * * * *` | ivrm-dash-minutely (curl + SQL) |
| ivrm-reliability-burn-reconcile | `* * * * *` | ivrm-dash-minutely (HTTP kick to the console route) |
| ivrm-notification-dispatch-v1 | `* * * * *` | apps/dispatch-worker (polling) |
| ivrm-observability-rollup-5m | `*/5 * * * *` | ivrm-dash-rollup |
| ivrm-observability-retention-v1 | `17 */6 * * *` | ivrm-dash-retention |
| ivrm-console-log-retention-v1 | `11 * * * *` | ivrm-dash-consolelog |
| ivrm-cloud-monitor-retention-v1 | `17 3 * * *` | ivrm-dash-cloudret |

The reliability burn kick used pg_net + a Vault token. The timer instead
curls `https://console.ivrm.jp/api/reliability/burn-reconcile` with a token
whose SHA-256 is registered in `reliability_burn_reconcile_credentials`
(id = 1). The token itself lives only in
`/etc/ivrm-dashboard-timers/burn-token` (root, 600) on the database host;
it was rotated at cutover (the Vault original was never extracted).

SQL services run as the `postgres` OS user against the local `ivrm_dashboard`
database, mirroring pg_cron's execution context. SECURITY DEFINER function
owners carry BYPASSRLS so the rollup/retention writes pass FORCE RLS.
