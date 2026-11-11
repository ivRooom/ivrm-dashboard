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
PSQL="/usr/bin/runuser -u postgres -- /usr/bin/psql -d ivrm_dashboard -At"

$PSQL -c "select public.capture_expired_container_maintenance_events()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "maintenance-expiry failed"
$PSQL -c "select public.reconcile_notification_scheduled_signals_v1()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "notification-reconcile failed"
$PSQL -c "select public.reconcile_notification_container_signals_v1()" >/dev/null 2>&1 \
  || logger -t ivrm-dash-minutely "container-reconcile failed"
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
