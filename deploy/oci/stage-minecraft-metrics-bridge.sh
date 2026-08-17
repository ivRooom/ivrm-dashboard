#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
BRIDGE_DIR="${REPO_ROOT}/apps/minecraft-metrics-bridge"
BRIDGE_JAR_NAME="ivrm-metrics-bridge.jar"
CONTAINER_NAME="mc-main"
CONTAINER_JAR_PATH="/data/mods/${BRIDGE_JAR_NAME}"
BUILDER_IMAGE="eclipse-temurin:25-jdk"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ivrm-metrics-bridge-stage.XXXXXX")"
OUTPUT_JAR="${WORK_DIR}/${BRIDGE_JAR_NAME}"
BACKUP_JAR="${WORK_DIR}/${BRIDGE_JAR_NAME}.previous"

cleanup() {
  rm -rf -- "${WORK_DIR}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "必要なコマンドがありません: $1"
}

for command_name in git sudo docker sha256sum; do
  require_command "${command_name}"
done

[[ -x "${BRIDGE_DIR}/build.sh" ]] || fail "Metrics Bridge build scriptがありません"
[[ -f "${BRIDGE_DIR}/src/main/java/jp/ivrm/metrics/IvrmMetricsBridge.java" ]] || fail "Metrics Bridge sourceがありません"
[[ -f "${BRIDGE_DIR}/src/main/resources/fabric.mod.json" ]] || fail "fabric.mod.jsonがありません"

if ! git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Git checkout内で実行してください"
fi

if ! sudo docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -qx 'true'; then
  fail "${CONTAINER_NAME} がrunningではありません"
fi

if ! sudo test -f /etc/ivrm-agent/docker.env; then
  fail "/etc/ivrm-agent/docker.env がありません"
fi

PERFORMANCE_SETTING="$(
  sudo awk -F= '$1 == "IVRM_MINECRAFT_PERFORMANCE_ENABLED" { print $2 }' \
    /etc/ivrm-agent/docker.env \
    | tail -n 1
)"
if [[ "${PERFORMANCE_SETTING,,}" != "false" ]]; then
  fail "PerformanceをfalseにしてからMetrics Bridgeをステージしてください"
fi

printf 'repo=%s\nsha=%s\n' \
  "${REPO_ROOT}" \
  "$(git -C "${REPO_ROOT}" rev-parse HEAD)"

printf '\n==> Metrics Bridgeをビルド\n'
if command -v javac >/dev/null 2>&1 && command -v jar >/dev/null 2>&1; then
  "${BRIDGE_DIR}/build.sh" "${OUTPUT_JAR}"
else
  # Build in an isolated JDK container. No network and no Docker socket are exposed.
  sudo docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=128m \
    --mount "type=bind,src=${BRIDGE_DIR},dst=/src,readonly" \
    --mount "type=bind,src=${WORK_DIR},dst=/out" \
    --entrypoint /bin/bash \
    "${BUILDER_IMAGE}" \
    /src/build.sh "/out/${BRIDGE_JAR_NAME}"
fi

[[ -s "${OUTPUT_JAR}" ]] || fail "Metrics Bridge jarを生成できませんでした"
printf 'sha256=%s\n' "$(sha256sum "${OUTPUT_JAR}" | awk '{print $1}')"

printf '\n==> 既存Bridgeを退避\n'
if sudo docker exec "${CONTAINER_NAME}" test -f "${CONTAINER_JAR_PATH}"; then
  sudo docker cp "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}" "${BACKUP_JAR}"
  printf 'previous_bridge=backed_up\n'
else
  printf 'previous_bridge=none\n'
fi

printf '\n==> mc-mainへBridgeをステージ\n'
if ! sudo docker cp "${OUTPUT_JAR}" "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}"; then
  if [[ -s "${BACKUP_JAR}" ]]; then
    sudo docker cp "${BACKUP_JAR}" "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}" || true
  fi
  fail "Metrics Bridge jarをステージできませんでした"
fi

sudo docker exec "${CONTAINER_NAME}" test -s "${CONTAINER_JAR_PATH}" \
  || fail "ステージ後のMetrics Bridge jarを確認できません"

printf '\n==> ステージ完了\n'
printf '%s\n' \
  "Minecraftは自動再起動していません。" \
  "PerformanceもOFFのままです。" \
  "次のメンテナンス再起動後に /data/ivrm/metrics.json が生成されることを確認してください。"
