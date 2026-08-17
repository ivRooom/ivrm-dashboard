#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd -P)"
BRIDGE_DIR="${REPO_ROOT}/apps/minecraft-metrics-bridge"
BRIDGE_JAR_NAME="ivrm-metrics-bridge.jar"
CONTAINER_NAME="mc-main"
CONTAINER_MODS_SOURCE_DIR="/mods"
CONTAINER_DATA_MODS_DIR="/data/mods"
CONTAINER_SOURCE_JAR_PATH="${CONTAINER_MODS_SOURCE_DIR}/${BRIDGE_JAR_NAME}"
CONTAINER_DATA_JAR_PATH="${CONTAINER_DATA_MODS_DIR}/${BRIDGE_JAR_NAME}"
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

mods_mount_source() {
  sudo docker inspect \
    --format '{{range .Mounts}}{{if eq .Destination "/mods"}}{{.Source}}{{end}}{{end}}' \
    "${CONTAINER_NAME}"
}

file_sha256() {
  sha256sum "$1" | awk '{print $1}'
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

if ! sudo docker exec "${CONTAINER_NAME}" test -d "${CONTAINER_MODS_SOURCE_DIR}"; then
  fail "${CONTAINER_NAME} に ${CONTAINER_MODS_SOURCE_DIR} がありません。永続Mod source mountを確認してください"
fi

if ! sudo docker exec "${CONTAINER_NAME}" test -d "${CONTAINER_DATA_MODS_DIR}"; then
  fail "${CONTAINER_NAME} に ${CONTAINER_DATA_MODS_DIR} がありません。NeoForge server構成を確認してください"
fi

# itzg/minecraft-serverは /mods を /data/mods へ起動時同期する。
# /data/modsへ直接書くと永続Source-of-Truthを外すため、Host bind mount側へ配置する。
MODS_SOURCE="$(mods_mount_source)"
[[ -n "${MODS_SOURCE}" ]] || fail "${CONTAINER_MODS_SOURCE_DIR} のHost mount sourceを特定できません"
sudo test -d "${MODS_SOURCE}" || fail "Host mods sourceがディレクトリではありません: ${MODS_SOURCE}"
HOST_JAR_PATH="${MODS_SOURCE}/${BRIDGE_JAR_NAME}"

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

printf 'repo=%s\nsha=%s\nmods_source=%s\n' \
  "${REPO_ROOT}" \
  "$(git -C "${REPO_ROOT}" rev-parse HEAD)" \
  "${MODS_SOURCE}"

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
OUTPUT_SHA="$(file_sha256 "${OUTPUT_JAR}")"
printf 'sha256=%s\n' "${OUTPUT_SHA}"

printf '\n==> 永続Mod sourceの既存Bridgeを退避\n'
if sudo test -f "${HOST_JAR_PATH}"; then
  sudo cp -a "${HOST_JAR_PATH}" "${BACKUP_JAR}"
  printf 'previous_bridge=backed_up\n'
else
  printf 'previous_bridge=none\n'
fi

rollback_source() {
  if [[ -s "${BACKUP_JAR}" ]]; then
    sudo install -m 0644 "${BACKUP_JAR}" "${HOST_JAR_PATH}" || true
  else
    sudo rm -f -- "${HOST_JAR_PATH}" || true
  fi
  sudo restorecon -F "${HOST_JAR_PATH}" 2>/dev/null || true
}

printf '\n==> 永続 /mods sourceへNeoForge Bridgeをステージ\n'
if ! sudo install -m 0644 "${OUTPUT_JAR}" "${HOST_JAR_PATH}"; then
  rollback_source
  fail "Metrics Bridge jarをHost mods sourceへステージできませんでした"
fi
sudo restorecon -F "${HOST_JAR_PATH}" 2>/dev/null || true

if ! sudo test -s "${HOST_JAR_PATH}"; then
  rollback_source
  fail "Host mods sourceのMetrics Bridge jarを確認できません"
fi

HOST_SHA="$(sudo sha256sum "${HOST_JAR_PATH}" | awk '{print $1}')"
if [[ "${HOST_SHA}" != "${OUTPUT_SHA}" ]]; then
  rollback_source
  fail "Host mods sourceのMetrics Bridge SHA256がbuild成果物と一致しません"
fi

# /modsがbind mountされていることも確認する。ここに見えなければ再起動時同期へ進まない。
if ! sudo docker exec "${CONTAINER_NAME}" test -s "${CONTAINER_SOURCE_JAR_PATH}"; then
  rollback_source
  fail "container ${CONTAINER_MODS_SOURCE_DIR} からMetrics Bridgeを確認できません"
fi

SOURCE_SHA="$(
  sudo docker exec "${CONTAINER_NAME}" sha256sum "${CONTAINER_SOURCE_JAR_PATH}" \
    | awk '{print $1}'
)"
if [[ "${SOURCE_SHA}" != "${OUTPUT_SHA}" ]]; then
  rollback_source
  fail "container ${CONTAINER_MODS_SOURCE_DIR} のMetrics Bridge SHA256が一致しません"
fi

printf '\n==> ステージ完了\n'
printf '%s\n' \
  "NeoForge Bridge JARを永続 /mods sourceへ配置しました。" \
  "Minecraftは自動再起動していません。" \
  "PerformanceもOFFのままです。" \
  "再起動時に /mods から ${CONTAINER_DATA_MODS_DIR} へ同期されます。" \
  "メンテナンス再起動後、${CONTAINER_DATA_JAR_PATH} と [ivrm-metrics-bridge] initialized と metrics.json を確認してください。"
