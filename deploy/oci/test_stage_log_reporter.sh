#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET="${SCRIPT_DIR}/stage-log-reporter.sh"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

require_literal() {
  local literal="$1"
  grep -F -- "${literal}" "${TARGET}" >/dev/null || \
    fail "必要な安全契約がありません: ${literal}"
}

forbid_literal() {
  local literal="$1"
  if grep -F -- "${literal}" "${TARGET}" >/dev/null; then
    fail "Log Reporter stageに禁止操作が含まれています: ${literal}"
  fi
}

[[ -f "${TARGET}" ]] || fail "stage-log-reporter.sh がありません"
bash -n "${TARGET}"

require_literal 'sudo test -f /etc/ivrm-agent/agent.env'
require_literal '/usr/local/libexec/ivrm-log-reporter'
require_literal '/etc/ivrm-agent/log.env'
require_literal 'IVRM_AGENT_LOG_ENDPOINT'
require_literal '[[ "${LOG_ENABLED}" == "false" ]]'
require_literal 'sudo systemctl enable --now ivrm-log-reporter.timer'

# Log Viewerだけのstageで既存監視やMinecraft runtimeを変更してはいけない。
forbid_literal 'IVRM_MINECRAFT_PERFORMANCE_ENABLED'
forbid_literal '/etc/ivrm-agent/docker.env'
forbid_literal 'systemctl restart ivrm-agent'
forbid_literal 'systemctl restart mc-main'
forbid_literal 'docker restart'
forbid_literal 'docker compose restart'
forbid_literal 'update-monitoring-stack.sh'

printf 'stage-log-reporter.sh safety contract: OK\n'
