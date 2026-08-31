#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET="${SCRIPT_DIR}/stage-mc-main-lifecycle.sh"
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
require_literal() { grep -F -- "$1" "${TARGET}" >/dev/null || fail "必要な安全契約がありません: $1"; }
forbid_literal() { if grep -F -- "$1" "${TARGET}" >/dev/null; then fail "Stageに禁止操作が含まれています: $1"; fi; }

[[ -f "${TARGET}" ]] || fail "stage-mc-main-lifecycle.sh がありません"
bash -n "${TARGET}"
require_literal 'IVRM_OPERATION_EXECUTION_ENABLED=false'
require_literal '[[ "${OP_ENABLED}" == "false" ]]'
require_literal '/usr/local/bin/ivrm-operation-worker'
require_literal '/usr/local/libexec/ivrm-mc-main-lifecycle'
require_literal '-o ivrm-agent -g ivrm-agent -m 0700 /run/ivrm-agent/operations/requests'
require_literal '-o root -g ivrm-agent -m 0750 /run/ivrm-agent/operations/results'
require_literal 'sudo systemctl stop ivrm-mc-main-lifecycle.timer'
require_literal 'sudo systemctl stop ivrm-operation-worker.service'
require_literal 'sudo systemctl is-active --quiet ivrm-mc-main-lifecycle.service'
require_literal 'sudo systemctl restart ivrm-operation-worker.service'
require_literal 'sudo systemctl start ivrm-mc-main-lifecycle.timer'
forbid_literal 'systemctl restart ivrm-agent'
forbid_literal 'systemctl restart mc-main'
forbid_literal 'docker restart'
forbid_literal 'docker stop'
forbid_literal 'docker kill'
forbid_literal 'docker start mc-main'
forbid_literal 'rcon'
printf 'stage-mc-main-lifecycle.sh safety contract: OK\n'
