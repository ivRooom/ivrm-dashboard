#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OUTPUT_PATH="${1:-${SCRIPT_DIR}/build/ivrm-metrics-bridge.jar}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ivrm-metrics-bridge-build.XXXXXX")"

cleanup() {
  rm -rf -- "${BUILD_DIR}"
}
trap cleanup EXIT

command -v javac >/dev/null 2>&1 || {
  echo "ERROR: javacがありません" >&2
  exit 1
}
command -v jar >/dev/null 2>&1 || {
  echo "ERROR: jarがありません" >&2
  exit 1
}

mkdir -p \
  "${BUILD_DIR}/stub/net/fabricmc/api" \
  "${BUILD_DIR}/classes" \
  "$(dirname -- "${OUTPUT_PATH}")"

# Compile-time only stub. The class is deliberately removed before packaging;
# Fabric Loader provides this interface at runtime.
cat >"${BUILD_DIR}/stub/net/fabricmc/api/ModInitializer.java" <<'JAVA'
package net.fabricmc.api;

public interface ModInitializer {
    void onInitialize();
}
JAVA

javac \
  --release 21 \
  -Xlint:all \
  -Werror \
  -d "${BUILD_DIR}/classes" \
  "${BUILD_DIR}/stub/net/fabricmc/api/ModInitializer.java" \
  "${SCRIPT_DIR}/src/main/java/jp/ivrm/metrics/IvrmMetricsBridge.java"

rm -rf -- "${BUILD_DIR}/classes/net/fabricmc"
cp \
  "${SCRIPT_DIR}/src/main/resources/fabric.mod.json" \
  "${BUILD_DIR}/classes/fabric.mod.json"

jar \
  --create \
  --file "${OUTPUT_PATH}" \
  -C "${BUILD_DIR}/classes" .

if jar --list --file "${OUTPUT_PATH}" | grep -q '^net/fabricmc/'; then
  echo "ERROR: Fabric compile stubが成果物へ混入しました" >&2
  exit 1
fi

if ! jar --list --file "${OUTPUT_PATH}" | grep -q '^fabric.mod.json$'; then
  echo "ERROR: fabric.mod.jsonが成果物にありません" >&2
  exit 1
fi

if ! jar --list --file "${OUTPUT_PATH}" | grep -q '^jp/ivrm/metrics/IvrmMetricsBridge.class$'; then
  echo "ERROR: Metrics Bridge classが成果物にありません" >&2
  exit 1
fi

printf 'built=%s\n' "${OUTPUT_PATH}"
