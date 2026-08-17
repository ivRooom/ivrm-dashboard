#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET="${SCRIPT_DIR}/stage-minecraft-metrics-bridge.sh"

require_text() {
  local needle="$1"
  grep -Fq -- "${needle}" "${TARGET}" || {
    printf 'ERROR: staging contract is missing: %s\n' "${needle}" >&2
    exit 1
  }
}

reject_text() {
  local needle="$1"
  if grep -Fq -- "${needle}" "${TARGET}"; then
    printf 'ERROR: staging contract must not contain: %s\n' "${needle}" >&2
    exit 1
  fi
}

# Production itzg/minecraft-server uses /mods as the persistent source that is
# synchronized into /data/mods at startup. Staging must therefore discover the
# host mount source instead of writing the artifact directly into /data/mods.
require_text 'eq .Destination "/mods"'
require_text 'HOST_JAR_PATH="${MODS_SOURCE}/${BRIDGE_JAR_NAME}"'
require_text 'sudo install -m 0644 "${OUTPUT_JAR}" "${HOST_JAR_PATH}"'
require_text 'CONTAINER_SOURCE_JAR_PATH="${CONTAINER_MODS_SOURCE_DIR}/${BRIDGE_JAR_NAME}"'
require_text 'SOURCE_SHA='
require_text 'PerformanceをfalseにしてからMetrics Bridgeをステージしてください'

reject_text 'docker cp "${OUTPUT_JAR}" "${CONTAINER_NAME}:${CONTAINER_DATA_JAR_PATH}"'
reject_text 'docker cp "${OUTPUT_JAR}" "${CONTAINER_NAME}:${CONTAINER_JAR_PATH}"'

printf 'metrics_bridge_staging_contract=ok\n'
