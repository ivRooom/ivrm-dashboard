#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
BRIDGE_DIR="${REPO_ROOT}/apps/minecraft-metrics-bridge"
BRIDGE_JAR_NAME="ivrm-metrics-bridge.jar"
CONTAINER_NAME="mc-main"
CONTAINER_MODS_DIR="/data/mods"
CONTAINER_JAR_PATH="${CONTAINER_MODS_DIR}/${BRIDGE_JAR_NAME}"
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

local_jdk_usable() {
  command -v javac >/dev/null 2>&1 || return 1
  command -v jar >/dev/null 2>&1 || return 1

  local version_output version major
  version_output="$(javac -version 2>&1)" || return 1
  version="${version_output#javac }"
  major="${version%%.*}"
  [[ "${major}" =~ ^[0-9]+$ ]] || return 1
  (( major >= 21 ))
}

for command_name in git sudo docker sha256sum; do
  require_command "${command_name}"
done

[[ -f "${BRIDGE_DIR}/build.sh" ]] || fail "Metrics Bridge build scriptがありません"
[[ -f "${BRIDGE_DIR}/src/main/java/jp/ivrm/metrics/IvrmMetricsBridge.java" ]] || fail "Metrics Bridge sourceがありません"
[[ -f "${BRIDGE_DIR}/src/main/resources/META-INF/neoforge.mods.toml" ]] \
  || fail "neoforge.mods.tomlがありません"

if ! git -C "${REPO_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "Git checkout内で実行してください"
fi

if ! sudo docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}" 2>/dev/null | grep -qx 'true'; then
  fail "${CONTAINER_NAME} がrunningではありません"
fi

if ! sudo docker exec "${CONTAINER_NAME}" test -d "${CONTAINER_MODS_DIR}"; then
  fail "${CONTAINER_NAME} に ${CONTAINER_MODS_DIR} がありません。NeoForge server構成を確認してください"
fi

# Productionで実際に利用しているSparkはNeoForge版。Fabric/Forge環境への誤配置を防ぐ。
if ! sudo docker exec "${CONTAINER_NAME}" sh -c \
  'find /data/mods -maxdepth 1 -type f -name "spark-*-neoforge.jar" -print -quit | grep -q .'; then
  fail "NeoForge版Sparkが見つかりません。mc-mainのMod Loaderを確認してください"
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

printf '\n==> NeoForge Metrics Bridgeをビルド\n'
if local_jdk_usable; then
  printf 'builder=host-jdk\n'
  bash "${BRIDGE_DIR}/build.sh" "${OUTPUT_JAR}"
else
  printf 'builder=%s\n' "${BUILDER_IMAGE}"
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

printf '\n==> mc-mainへNeoForge Bridgeをステージ\n'
if ! sudo docker cp "${OUTPUT_JAR}" "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}"; then
  if [[ -s "${BACKUP_JAR}" ]]; then
    sudo docker cp "${BACKUP_JAR}" "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}" || true
  fi
  fail "Metrics Bridge jarをステージできませんでした"
fi

if ! sudo docker exec "${CONTAINER_NAME}" test -s "${CONTAINER_JAR_PATH}"; then
  if [[ -s "${BACKUP_JAR}" ]]; then
    sudo docker cp "${BACKUP_JAR}" "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}" || true
  else
    sudo docker exec "${CONTAINER_NAME}" rm -f "${CONTAINER_JAR_PATH}" || true
  fi
  fail "ステージ後のMetrics Bridge jarを確認できません"
fi

printf '\n==> ステージ完了\n'
printf '%s\n' \
  "NeoForge Bridge JARを配置しました。" \
  "Minecraftは自動再起動していません。" \
  "PerformanceもOFFのままです。" \
  "メンテナンス再起動後、[ivrm-metrics-bridge] initialized と metrics.json を確認してください。"
