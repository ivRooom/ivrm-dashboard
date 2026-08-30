#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
EXPECTED_ENDPOINT="https://console.ivrm.jp/api/agent/logs"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "必要なコマンドがありません: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "必要なファイルがありません: $1"
}

for command_name in git python3 sudo systemctl systemd-analyze; do
  require_command "${command_name}"
done

for required_path in \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.py" \
  "${REPO_ROOT}/deploy/oci/test_ivrm_log_reporter.py" \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.service" \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.timer" \
  "${REPO_ROOT}/deploy/oci/log.env.example"; do
  require_file "${required_path}"
done

if ! git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Git checkout内で実行してください"
fi

SOURCE_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
SOURCE_BRANCH="$(git -C "${REPO_ROOT}" branch --show-current || true)"
printf 'repo=%s\nbranch=%s\nsha=%s\n' \
  "${REPO_ROOT}" "${SOURCE_BRANCH:-detached}" "${SOURCE_SHA}"

printf '\n==> Log Reporterをテスト\n'
cd -- "${REPO_ROOT}"
python3 -m py_compile deploy/oci/ivrm-log-reporter.py
python3 -m unittest deploy/oci/test_ivrm_log_reporter.py

printf '\n==> 既存Agent Secretを確認\n'
sudo test -f /etc/ivrm-agent/agent.env || \
  fail "/etc/ivrm-agent/agent.env がありません。既存Secretを再利用できないため中止します。"

printf '\n==> Log ReporterをOFFでstage\n'
sudo install -d -o root -g root -m 755 /usr/local/libexec /etc/ivrm-agent
sudo install -o root -g root -m 755 \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.py" \
  /usr/local/libexec/ivrm-log-reporter
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.service" \
  /etc/systemd/system/ivrm-log-reporter.service
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.timer" \
  /etc/systemd/system/ivrm-log-reporter.timer
sudo install -o root -g root -m 600 \
  "${REPO_ROOT}/deploy/oci/log.env.example" \
  /etc/ivrm-agent/log.env

sudo python3 - "${EXPECTED_ENDPOINT}" <<'PY'
from pathlib import Path
import sys

expected = sys.argv[1]
path = Path('/etc/ivrm-agent/agent.env')
lines = path.read_text().splitlines()
key = 'IVRM_AGENT_LOG_ENDPOINT'
updated = []
found = False

for line in lines:
    if line.startswith(f'{key}='):
        if not found:
            updated.append(f'{key}={expected}')
            found = True
        continue
    updated.append(line)

if not found:
    updated.append(f'{key}={expected}')

path.write_text('\n'.join(updated) + '\n')
PY
sudo chown root:ivrm-agent /etc/ivrm-agent/agent.env
sudo chmod 640 /etc/ivrm-agent/agent.env

printf '\n==> systemd unitを検証\n'
sudo systemd-analyze verify \
  /etc/systemd/system/ivrm-log-reporter.service \
  /etc/systemd/system/ivrm-log-reporter.timer
sudo systemctl daemon-reload
sudo systemctl enable --now ivrm-log-reporter.timer >/dev/null
sudo systemctl start ivrm-log-reporter.service

LOG_ENABLED="$(sudo awk -F= '$1 == "IVRM_LOG_REPORTING_ENABLED" {print $2}' /etc/ivrm-agent/log.env)"
[[ "${LOG_ENABLED}" == "false" ]] || fail "stage後のLog ReportingがOFFではありません"
sudo systemctl is-active --quiet ivrm-log-reporter.timer || fail "Log Reporter timerがactiveではありません"
ACTUAL_ENDPOINT="$(sudo awk -F= '$1 == "IVRM_AGENT_LOG_ENDPOINT" {print substr($0, index($0, "=") + 1)}' /etc/ivrm-agent/agent.env)"
[[ "${ACTUAL_ENDPOINT}" == "${EXPECTED_ENDPOINT}" ]] || fail "Log Endpointが期待値と一致しません"

printf '\n==> stage完了\n'
printf '%s\n' \
  "logReporting=${LOG_ENABLED}" \
  "logEndpoint=${ACTUAL_ENDPOINT}" \
  "Minecraft / Agent / Performanceは再起動・変更していません。" \
  "MigrationとWeb Production確認後にのみIVRM_LOG_REPORTING_ENABLED=trueへ変更してください。"
