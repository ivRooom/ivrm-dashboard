#!/bin/bash
# ivrm-dashboard: quiz stock checker (ivrm-web Issue #749).
#
# Runs every 10 minutes (ivrm-dash-quiz-check.timer) on the database
# host. Reads the quiz stock in the ivrm_api database through the
# existing read-only role (ivrm_dashboard_points_ro, extended by the
# approval-gated grants in deploy/quiz-monitor/) and records one
# observation row in ivrm_dashboard via
# record_quiz_stock_observation_v1(). Threshold evaluation and
# notification live in reconcile_quiz_stock_signals_v1(), which
# ivrm-dash-minutely runs every minute.
#
# The reads are SELECT-only preflight checks: this script never calls
# the publication materializer, so observing can never fix (or hide) a
# missing day by creating it.
#
# What is observed, for the current slot day and the next slot day
# (slot day = JST date with a 09:00 boundary, the API's dailySlotDate):
#   * V2 (daily_questions, date-fixed): ready rows for today and
#     tomorrow (slot 'daily', status approved/published), draft rows,
#     tomorrow's bonus ready rows, and the runway of consecutive
#     ready days starting tomorrow (capped at 14).
#   * V1 (daily_login_quizzes / daily_login_quiz_publications):
#     whether today's publication is already fixed to quiz_id 'none',
#     and tomorrow's selectDailyQuiz candidate count (approved and
#     unscheduled or scheduled for tomorrow), split into fixed/pool.
#
# Fail-safe: when the read-only connection is not configured or
# ivrm_api cannot be reached, the observation is recorded with a
# non-ok status and NO counts, so stock is never judged on missing
# data. A prolonged absence of 'ok' observations is itself surfaced
# by the quiz:stock-monitor-stale signal.
#
# The read-only connection reuses the point monitor's libpq service
# file (no new secret):
#   /etc/ivrm-dashboard-timers/points-api.pgservice (root, 600)
#     [points-api]
#     host=<db host> port=5432 dbname=ivrm_api
#     user=ivrm_dashboard_points_ro password=<set at role creation>
set -u
PSQL_DASH="/usr/sbin/runuser -u postgres -- /usr/bin/psql -d ivrm_dashboard -At -q"
SERVICE_FILE=/etc/ivrm-dashboard-timers/points-api.pgservice

record() {
  # $1 = status; ok: $2.. = slot_day, target_day, then the 10 measures;
  # non-ok: $2 = detail
  if [ "$1" = "ok" ]; then
    $PSQL_DASH -c "select public.record_quiz_stock_observation_v1('ok', '$2', '$3', $4, $5, $6, $7, $8, $9, ${10}, ${11}, ${12}, ${13}, null)" >/dev/null 2>&1 \
      || logger -t ivrm-dash-quiz-check "record ok failed"
  else
    $PSQL_DASH -c "select public.record_quiz_stock_observation_v1('$1', null, null, null, null, null, null, null, null, null, null, null, null, '$2')" >/dev/null 2>&1 \
      || logger -t ivrm-dash-quiz-check "record $1 failed"
  fi
}

if [ ! -r "$SERVICE_FILE" ]; then
  logger -t ivrm-dash-quiz-check "points-api service file missing; recording unconfigured"
  record unconfigured not_configured
  exit 0
fi

# One row, CSV: slot_day, target_day, v2_today_ready, v2_today_draft,
# v2_next_ready, v2_next_draft, v2_next_bonus_ready, v2_runway_days,
# v1_none (t/f), v1_next_candidates, v1_next_fixed, v1_pool.
# date_jst / claim_date_jst / scheduled_date are JST date values in
# ivrm_api; they are compared as ISO text so the query works whether
# the columns are text or date.
COUNTS=$(PGSERVICEFILE="$SERVICE_FILE" PGSERVICE=points-api PGCONNECT_TIMEOUT=10 \
  PGOPTIONS="-c statement_timeout=15000" \
  /usr/bin/psql -At -F, -v ON_ERROR_STOP=1 -c "
with slot as (
  select case when (clock_timestamp() at time zone 'Asia/Tokyo')::time < time '09:00'
              then (clock_timestamp() at time zone 'Asia/Tokyo')::date - 1
              else (clock_timestamp() at time zone 'Asia/Tokyo')::date end as slot_day
),
days as (
  select slot_day, slot_day + 1 as target_day, slot_day + 14 as horizon_day
  from slot
),
first_gap as (
  select min(g.d) as gap_day
  from days
  cross join lateral (
    select generate_series(days.target_day, days.horizon_day, interval '1 day')::date as d
  ) as g
  where not exists (
    select 1 from ivrm_api.daily_questions q
    where q.date_jst::text = g.d::text and q.slot = 'daily'
      and q.status in ('approved','published'))
)
select days.slot_day, days.target_day,
  (select count(*) from ivrm_api.daily_questions
    where date_jst::text = days.slot_day::text and slot = 'daily'
      and status in ('approved','published')),
  (select count(*) from ivrm_api.daily_questions
    where date_jst::text = days.slot_day::text and slot = 'daily'
      and status = 'draft'),
  (select count(*) from ivrm_api.daily_questions
    where date_jst::text = days.target_day::text and slot = 'daily'
      and status in ('approved','published')),
  (select count(*) from ivrm_api.daily_questions
    where date_jst::text = days.target_day::text and slot = 'daily'
      and status = 'draft'),
  (select count(*) from ivrm_api.daily_questions
    where date_jst::text = days.target_day::text and slot = 'bonus'
      and status in ('approved','published')),
  coalesce(first_gap.gap_day - days.target_day, 14),
  exists (select 1 from ivrm_api.daily_login_quiz_publications
    where claim_date_jst::text = days.slot_day::text and quiz_id = 'none'),
  (select count(*) from ivrm_api.daily_login_quizzes
    where status = 'approved'
      and (scheduled_date is null or scheduled_date::text = days.target_day::text)),
  (select count(*) from ivrm_api.daily_login_quizzes
    where status = 'approved'
      and scheduled_date::text = days.target_day::text),
  (select count(*) from ivrm_api.daily_login_quizzes
    where status = 'approved' and scheduled_date is null)
from days, first_gap" \
  2>/dev/null) || COUNTS=""

case "$COUNTS" in
  ''|*[!0-9tf,-]*)
    logger -t ivrm-dash-quiz-check "ivrm_api query failed; recording unreachable"
    record unreachable query_failed
    ;;
  *)
    IFS=, read -r SLOT_DAY TARGET_DAY T_READY T_DRAFT N_READY N_DRAFT N_BONUS RUNWAY V1_NONE V1_CAND V1_FIXED V1_POOL <<< "$COUNTS"
    if [ -n "${SLOT_DAY:-}" ] && [ -n "${TARGET_DAY:-}" ] && [ -n "${RUNWAY:-}" ] \
      && { [ "$V1_NONE" = "t" ] || [ "$V1_NONE" = "f" ]; }; then
      V1_NONE_SQL=$([ "$V1_NONE" = "t" ] && echo true || echo false)
      record ok "$SLOT_DAY" "$TARGET_DAY" "$T_READY" "$T_DRAFT" "$N_READY" "$N_DRAFT" "$N_BONUS" "$RUNWAY" "$V1_NONE_SQL" "$V1_CAND" "$V1_FIXED" "$V1_POOL"
    else
      logger -t ivrm-dash-quiz-check "unexpected counts output; recording error"
      record error bad_counts
    fi
    ;;
esac
exit 0
