#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
BUILD_OUTPUT="${TMPDIR:-/tmp}/ivrm-operation-worker-stage-$$"

cleanup() { rm -f -- "${BUILD_OUTPUT}"; }
trap cleanup EXIT
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_file() { [[ -f "$1" ]] || fail "必要なファイルがありません: $1"; }

for command_name in go python3 sudo systemctl systemd-analyze; do
  command -v "${command_name}" >/dev/null 2>&1 || fail "必要なコマンドがありません: ${command_name}"
done

for path in \
  "${REPO_ROOT}/apps/agent/cmd/ivrm-operation-worker/main.go" \
  "${REPO_ROOT}/deploy/oci/ivrm-mc-main-lifecycle.py" \
  "${REPO_ROOT}/deploy/oci/test_ivrm_mc_main_lifecycle.py" \
  "${REPO_ROOT}/deploy/oci/operation.env.example" \
  "${REPO_ROOT}/deploy/oci/ivrm-operation-worker.service" \
  "${REPO_ROOT}/deploy/oci/ivrm-mc-main-lifecycle.service" \
  "${REPO_ROOT}/deploy/oci/ivrm-mc-main-lifecycle.timer"; do
  require_file "${path}"
done

# Stage is explicitly non-destructive. The repository default is OFF and the
# installed environment is rewritten to OFF before any staged unit is started.
IVRM_OPERATION_EXECUTION_ENABLED=false

cd -- "${REPO_ROOT}"
python3 -m py_compile deploy/oci/ivrm-mc-main-lifecycle.py
python3 -m unittest deploy/oci/test_ivrm_mc_main_lifecycle.py
(
  cd apps/agent
  go test ./cmd/ivrm-operation-worker
  go build -trimpath -ldflags='-s -w' -o "${BUILD_OUTPUT}" ./cmd/ivrm-operation-worker
)
[[ -s "${BUILD_OUTPUT}" ]] || fail "Operation Worker binaryを生成できませんでした"

sudo test -f /etc/ivrm-agent/agent.env || fail "/etc/ivrm-agent/agent.env がありません"
sudo install -d -o root -g ivrm-agent -m 0750 /run/ivrm-agent/operations
# Only the dedicated worker user can publish requests. Group members cannot inject lifecycle actions.
sudo install -d -o ivrm-agent -g ivrm-agent -m 0700 /run/ivrm-agent/operations/requests
# The root helper owns results; the worker group can only read them.
sudo install -d -o root -g ivrm-agent -m 0750 /run/ivrm-agent/operations/results
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -d -o root -g root -m 0755 /etc/ivrm-agent

sudo install -o root -g root -m 0755 "${BUILD_OUTPUT}" /usr/local/bin/ivrm-operation-worker
sudo install -o root -g root -m 0755 "${REPO_ROOT}/deploy/oci/ivrm-mc-main-lifecycle.py" /usr/local/libexec/ivrm-mc-main-lifecycle
sudo install -o root -g root -m 0644 "${REPO_ROOT}/deploy/oci/ivrm-operation-worker.service" /etc/systemd/system/ivrm-operation-worker.service
sudo install -o root -g root -m 0644 "${REPO_ROOT}/deploy/oci/ivrm-mc-main-lifecycle.service" /etc/systemd/system/ivrm-mc-main-lifecycle.service
sudo install -o root -g root -m 0644 "${REPO_ROOT}/deploy/oci/ivrm-mc-main-lifecycle.timer" /etc/systemd/system/ivrm-mc-main-lifecycle.timer
sudo install -o root -g root -m 0600 "${REPO_ROOT}/deploy/oci/operation.env.example" /etc/ivrm-agent/operation.env

# Keep the stage gate explicit and machine-verifiable.
sudo sed -i 's/^IVRM_OPERATION_EXECUTION_ENABLED=.*/IVRM_OPERATION_EXECUTION_ENABLED=false/' /etc/ivrm-agent/operation.env
OP_ENABLED="$(sudo awk -F= '$1 == "IVRM_OPERATION_EXECUTION_ENABLED" {print $2}' /etc/ivrm-agent/operation.env)"
[[ "${OP_ENABLED}" == "false" ]] || fail "Operation executionがOFFではありません"

sudo systemd-analyze verify \
  /etc/systemd/system/ivrm-operation-worker.service \
  /etc/systemd/system/ivrm-mc-main-lifecycle.service \
  /etc/systemd/system/ivrm-mc-main-lifecycle.timer
sudo systemctl daemon-reload

# A previously running worker keeps its old environment until it is restarted.
# Freeze timer delivery first, stop the worker, and refuse to proceed while a
# root helper invocation is already active. This prevents a stage rerun from
# claiming/executing with a stale execution=true process environment.
sudo systemctl stop ivrm-mc-main-lifecycle.timer >/dev/null 2>&1 || true
sudo systemctl stop ivrm-operation-worker.service >/dev/null 2>&1 || true
if sudo systemctl is-active --quiet ivrm-mc-main-lifecycle.service; then
  fail "Lifecycle helperが実行中です。完了後にStageを再実行してください"
fi

sudo systemctl enable ivrm-operation-worker.service >/dev/null
sudo systemctl enable ivrm-mc-main-lifecycle.timer >/dev/null
sudo systemctl restart ivrm-operation-worker.service
sudo systemctl start ivrm-mc-main-lifecycle.timer
sudo systemctl is-active --quiet ivrm-operation-worker.service || fail "Operation Workerがactiveではありません"
sudo systemctl is-active --quiet ivrm-mc-main-lifecycle.timer || fail "Lifecycle timerがactiveではありません"

printf 'mc-main lifecycle stage: OK\n'
printf 'IVRM_OPERATION_EXECUTION_ENABLED=false\n'
printf 'Operation Worker was restarted with execution disabled.\n'
printf 'Minecraft lifecycle action was NOT executed.\n'
