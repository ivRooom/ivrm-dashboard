#!/bin/bash
# ivrm-dashboard: point-grant liveness checker (Issue #221).
#
# Runs every 10 minutes (ivrm-dash-points-check.timer) on the database
# host. Counts today's (JST) login-bonus claims, point earn
# transactions and received XP events in the ivrm_api database through
# a read-only role, and records one observation row in ivrm_dashboard
# via record_point_grant_observation_v1(). Threshold evaluation and
# notification live in reconcile_point_grant_signals_v1(), which
# ivrm-dash-minutely runs every minute.
#
# Fail-safe: when the read-only connection is not configured or
# ivrm_api cannot be reached, the observation is recorded with a
# non-ok status and NO counts, so the liveness signal is never judged
# on missing data. A prolonged absence of 'ok' observations is itself
# surfaced by the points:grant-monitor-stale signal.
#
# The read-only connection is a libpq service file:
#   /etc/ivrm-dashboard-timers/points-api.pgservice (root, 600)
#     [points-api]
#     host=<db host> port=5432 dbname=ivrm_api
#     user=ivrm_dashboard_points_ro password=<set at role creation>
# The role is created by an approval-gated step
# (deploy/points-monitor/ivrm_api_readonly_role.sql); the password
# lives only in that file and is never committed.
set -u
PSQL_DASH="/usr/sbin/runuser -u postgres -- /usr/bin/psql -d ivrm_dashboard -At -q"
SERVICE_FILE=/etc/ivrm-dashboard-timers/points-api.pgservice

record() {
  # $1 = status, $2.. = counts (ok) or detail (non-ok)
  if [ "$1" = "ok" ]; then
    $PSQL_DASH -c "select public.record_point_grant_observation_v1('ok', $2, $3, $4, null)" >/dev/null 2>&1 \
      || logger -t ivrm-dash-points-check "record ok failed"
  else
    $PSQL_DASH -c "select public.record_point_grant_observation_v1('$1', null, null, null, '$2')" >/dev/null 2>&1 \
      || logger -t ivrm-dash-points-check "record $1 failed"
  fi
}

if [ ! -r "$SERVICE_FILE" ]; then
  logger -t ivrm-dash-points-check "points-api service file missing; recording unconfigured"
  record unconfigured not_configured
  exit 0
fi

# One row, CSV: claims, earn, xp for the current JST day. Timestamps in
# ivrm_api are ISO-8601 UTC text; the JST day is derived in SQL, in the
# same way the API itself derives it (created_at::timestamptz in
# Asia/Tokyo). claim_date_jst is already the JST date string.
COUNTS=$(PGSERVICEFILE="$SERVICE_FILE" PGSERVICE=points-api PGCONNECT_TIMEOUT=10 \
  PGOPTIONS="-c statement_timeout=15000" \
  /usr/bin/psql -At -F, -v ON_ERROR_STOP=1 -c "select (select count(*) from ivrm_api.login_bonus_claims where claim_date_jst = to_char(clock_timestamp() at time zone 'Asia/Tokyo', 'YYYY-MM-DD')), (select count(*) from ivrm_api.point_transactions where type = 'earn' and (created_at::timestamptz at time zone 'Asia/Tokyo')::date = (clock_timestamp() at time zone 'Asia/Tokyo')::date), (select count(*) from ivrm_api.xp_events where (received_at::timestamptz at time zone 'Asia/Tokyo')::date = (clock_timestamp() at time zone 'Asia/Tokyo')::date)" \
  2>/dev/null) || COUNTS=""

case "$COUNTS" in
  ''|*[!0-9,]*)
    logger -t ivrm-dash-points-check "ivrm_api query failed; recording unreachable"
    record unreachable query_failed
    ;;
  *)
    IFS=, read -r CLAIMS EARN XP <<< "$COUNTS"
    if [ -n "${CLAIMS:-}" ] && [ -n "${EARN:-}" ] && [ -n "${XP:-}" ]; then
      record ok "$CLAIMS" "$EARN" "$XP"
    else
      logger -t ivrm-dash-points-check "unexpected counts output; recording error"
      record error bad_counts
    fi
    ;;
esac
exit 0
