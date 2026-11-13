#!/bin/bash
# ivrm-dashboard: every-minute jobs, replacing the Supabase pg_cron entries
#   ivrm-maintenance-expiry-events        -> capture_expired_container_maintenance_events()
#   ivrm-notification-reconcile-v1        -> reconcile_notification_scheduled_signals_v1()
#   ivrm-notification-container-reconcile -> reconcile_notification_container_signals_v1()
#   ivrm-cloud-monitor-reconcile-v1       -> reconcile_cloud_monitor_signals_v1()
#   ivrm-reliability-burn-reconcile       -> HTTP kick to the console route
#     (the pg_net/vault kick function is replaced by a direct curl; the token
#      was rotated at cutover and lives in /etc/ivrm-dashboard-timers/burn-token)
set -u
PSQL="/usr/sbin/runuser -u postgres -- /usr/bin/psql -d ivrm_dashboard -At"

$PSQL -c "select public.capture_expired_container_maintenance_events()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "maintenance-expiry failed"
$PSQL -c "select public.reconcile_notification_scheduled_signals_v1()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "notification-reconcile failed"
$PSQL -c "select public.reconcile_notification_container_signals_v1()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "container-reconcile failed"

# Console (Vercel) ingest health probe (Issue #215): record whether the
# console is disabled (HTTP 402 / DEPLOYMENT_DISABLED, e.g. a Hobby
# fair-use pause) before cloud reconcile runs, so a full ingest outage
# can be labelled with its detected cause. Runs over a direct DB
# connection, so it keeps working while the console itself is down.
PROBE_BODY=$(mktemp)
PROBE_CODE=$(curl -s -o "$PROBE_BODY" -w '%{http_code}' --max-time 15 \
  https://console.ivrm.jp/api/agent/heartbeat) || PROBE_CODE=000
case "$PROBE_CODE" in ''|*[!0-9]*) PROBE_CODE=000 ;; esac
if grep -q 'DEPLOYMENT_DISABLED' "$PROBE_BODY"; then PROBE_DISABLED=true; else PROBE_DISABLED=false; fi
rm -f "$PROBE_BODY"
$PSQL -c "select public.record_console_ingest_health_v1(${PROBE_CODE}, ${PROBE_DISABLED}, 'console.ivrm.jp/api/agent/heartbeat')" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "console-probe failed"

$PSQL -c "select public.reconcile_cloud_monitor_signals_v1()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "cloud-monitor-reconcile failed"

TOKEN_FILE=/etc/ivrm-dashboard-timers/burn-token
if [ -r "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    https://console.ivrm.jp/api/reliability/burn-reconcile \
    -H "Content-Type: application/json" \
    -H "x-ivrm-reliability-token: ${TOKEN}" \
    -d '{}' --max-time 20 || echo 000)
  [ "$CODE" = "200" ] || logger -t ivrm-dash-minutely "burn-reconcile http ${CODE}"
else
  logger -t ivrm-dash-minutely "burn token file missing"
fi
exit 0
