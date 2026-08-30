#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
AGENT_DIR="${REPO_ROOT}/apps/agent"
BUILD_OUTPUT="${TMPDIR:-/tmp}/ivrm-agent-update-$$"

cleanup() {
  rm -f -- "${BUILD_OUTPUT}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

step() {
  printf '\n==> %s\n' "$*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "必要なコマンドがありません: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "必要なファイルがありません: $1"
}

for command_name in git python3 go sudo systemctl systemd-analyze; do
  require_command "${command_name}"
done

for required_path in \
  "${REPO_ROOT}/apps/agent/go.mod" \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-docker-snapshot.py" \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-minecraft-performance.py" \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.py" \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-docker-snapshot.service" \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-docker-snapshot.timer" \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.service" \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.timer" \
  "${REPO_ROOT}/deploy/oci/ivrm-agent.tmpfiles.conf" \
  "${REPO_ROOT}/deploy/oci/docker.env.example" \
  "${REPO_ROOT}/deploy/oci/log.env.example"; do
  require_file "${required_path}"
done

if ! git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Git checkout内で実行してください。READMEのclone手順からやり直してください。"
fi

SOURCE_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
SOURCE_BRANCH="$(git -C "${REPO_ROOT}" branch --show-current || true)"

step "Sourceを確認"
printf 'repo=%s\nbranch=%s\nsha=%s\n' \
  "${REPO_ROOT}" \
  "${SOURCE_BRANCH:-detached}" \
  "${SOURCE_SHA}"

step "Collectorをテスト"
cd -- "${REPO_ROOT}"
python3 -m py_compile deploy/oci/ivrm-agent-docker-snapshot.py
python3 -m unittest deploy/oci/test_ivrm_agent_docker_snapshot.py
python3 -m py_compile deploy/oci/ivrm-agent-minecraft-performance.py
python3 -m unittest deploy/oci/test_ivrm_agent_minecraft_performance.py
python3 -m py_compile deploy/oci/ivrm-backup-reporter.py
python3 -m unittest deploy/oci/test_ivrm_backup_reporter.py
python3 -m py_compile deploy/oci/ivrm-log-reporter.py
python3 -m unittest deploy/oci/test_ivrm_log_reporter.py

step "Go Agentをテスト・ビルド"
(
  cd -- "${AGENT_DIR}"
  go test ./...
  go build -trimpath -ldflags='-s -w' \
    -o "${BUILD_OUTPUT}" \
    ./cmd/ivrm-agent
)
[[ -s "${BUILD_OUTPUT}" ]] || fail "Agent binaryを生成できませんでした"

step "既存Agent Secretを確認"
if ! sudo test -f /etc/ivrm-agent/agent.env; then
  fail "/etc/ivrm-agent/agent.env がありません。Secretなしの状態を作らないため更新を中止します。"
fi

step "PerformanceとLog ReportingをOFFへ固定して配置"
sudo install -d -o root -g root -m 755 /usr/local/libexec
sudo install -d -o root -g root -m 755 /etc/ivrm-agent

sudo install -o root -g root -m 755 \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-docker-snapshot.py" \
  /usr/local/libexec/ivrm-agent-docker-snapshot
sudo install -o root -g root -m 755 \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-minecraft-performance.py" \
  /usr/local/libexec/ivrm-agent-minecraft-performance
sudo install -o root -g root -m 755 \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.py" \
  /usr/local/libexec/ivrm-log-reporter
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-docker-snapshot.service" \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-agent-docker-snapshot.timer" \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.service" \
  /etc/systemd/system/ivrm-log-reporter.service
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-log-reporter.timer" \
  /etc/systemd/system/ivrm-log-reporter.timer
sudo install -o root -g root -m 644 \
  "${REPO_ROOT}/deploy/oci/ivrm-agent.tmpfiles.conf" \
  /etc/tmpfiles.d/ivrm-agent.conf
sudo install -o root -g root -m 755 \
  "${BUILD_OUTPUT}" \
  /usr/local/bin/ivrm-agent

# docker.env/log.envにSecretは置かない設計。更新時は既知の固定設定へ戻し、
# PerformanceとLog Reportingは必ずOFFから開始する。
sudo install -o root -g root -m 600 \
  "${REPO_ROOT}/deploy/oci/docker.env.example" \
  /etc/ivrm-agent/docker.env
sudo install -o root -g root -m 600 \
  "${REPO_ROOT}/deploy/oci/log.env.example" \
  /etc/ivrm-agent/log.env

sudo python3 - <<'PY'
from pathlib import Path

path = Path('/etc/ivrm-agent/agent.env')
text = path.read_text().rstrip('\n')
lines = text.splitlines() if text else []
required = {
    'IVRM_AGENT_DOCKER_SNAPSHOT_PATH': '/run/ivrm-agent/docker-state.json',
    'IVRM_AGENT_LOG_ENDPOINT': 'https://console.ivrm.jp/api/agent/logs',
}

for key, value in required.items():
    if not any(item.startswith(f'{key}=') for item in lines):
        lines.append(f'{key}={value}')

path.write_text('\n'.join(lines) + '\n')
PY
sudo chown root:ivrm-agent /etc/ivrm-agent/agent.env
sudo chmod 640 /etc/ivrm-agent/agent.env
sudo systemd-tmpfiles --create /etc/tmpfiles.d/ivrm-agent.conf

step "systemd unitを検証"
sudo systemd-analyze verify \
  /etc/systemd/system/ivrm-agent-docker-snapshot.service \
  /etc/systemd/system/ivrm-agent-docker-snapshot.timer \
  /etc/systemd/system/ivrm-log-reporter.service \
  /etc/systemd/system/ivrm-log-reporter.timer
sudo systemctl daemon-reload
sudo systemctl enable --now ivrm-agent-docker-snapshot.timer >/dev/null
sudo systemctl enable --now ivrm-log-reporter.timer >/dev/null
sudo systemctl start ivrm-agent-docker-snapshot.service
sudo systemctl start ivrm-log-reporter.service

step "Performance OFFのSnapshotを検証"
sudo python3 - <<'PY'
import json
from pathlib import Path

path = Path('/run/ivrm-agent/docker-state.json')
document = json.loads(path.read_text())
containers = document.get('containers')
minecraft = document.get('minecraft')

if not isinstance(containers, list) or len(containers) != 4:
    raise SystemExit(f'ERROR: containersが4件ではありません: {len(containers) if isinstance(containers, list) else "invalid"}')
if not isinstance(minecraft, dict):
    raise SystemExit('ERROR: minecraft Status Probeがありません')
if minecraft.get('performance') is not None:
    raise SystemExit('ERROR: 初回配置でPerformanceが有効です')

print(f'generatedAt={document.get("generatedAt")}')
print(f'containers={len(containers)}')
print(f'publicReachable={minecraft.get("publicEndpoint", {}).get("reachable")}')
print(f'backendReachable={minecraft.get("backend", {}).get("reachable")}')
print('minecraftPerformance=false')
PY

step "Log Reporting OFFを検証"
LOG_ENABLED="$(sudo awk -F= '$1 == "IVRM_LOG_REPORTING_ENABLED" {print $2}' /etc/ivrm-agent/log.env)"
[[ "${LOG_ENABLED}" == "false" ]] || fail "初回配置でLog ReportingがOFFではありません"
printf 'logReporting=%s\n' "${LOG_ENABLED}"

step "Agent 0.6.0を再起動"
sudo systemctl restart ivrm-agent
sleep 3
sudo systemctl is-active --quiet ivrm-agent || fail "ivrm-agentがactiveではありません"
sudo systemctl is-active --quiet ivrm-agent-docker-snapshot.timer || fail "Docker Snapshot timerがactiveではありません"
sudo systemctl is-active --quiet ivrm-log-reporter.timer || fail "Log Reporter timerがactiveではありません"

step "更新完了"
printf '%s\n' \
  "Performanceは安全のためOFFです。" \
  "Log Reportingも安全のためOFFです。Migration/API/Redactionを確認するまでONにしないでください。" \
  "Minecraft Performanceはstage-minecraft-metrics-bridge.shとmetrics.json確認後に有効化してください。" \
  "Log ViewerはProduction MigrationとWeb deploy後、log.envを明示的にtrueへ変更して有効化してください。"
sudo journalctl -u ivrm-agent -n 8 --no-pager -l
