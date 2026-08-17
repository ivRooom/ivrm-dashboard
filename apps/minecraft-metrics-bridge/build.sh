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
  "${BUILD_DIR}/stub/net/neoforged/fml/common" \
  "${BUILD_DIR}/classes/META-INF" \
  "$(dirname -- "${OUTPUT_PATH}")"

# Compile-time only stub. NeoForge provides the real @Mod annotation at runtime.
cat >"${BUILD_DIR}/stub/net/neoforged/fml/common/Mod.java" <<'JAVA'
package net.neoforged.fml.common;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface Mod {
    String value();
}
JAVA

javac \
  --release 21 \
  -Xlint:all \
  -Werror \
  -d "${BUILD_DIR}/classes" \
  "${BUILD_DIR}/stub/net/neoforged/fml/common/Mod.java" \
  "${SCRIPT_DIR}/src/main/java/jp/ivrm/metrics/IvrmMetricsBridge.java"

rm -rf -- "${BUILD_DIR}/classes/net/neoforged"
cp \
  "${SCRIPT_DIR}/src/main/resources/META-INF/neoforge.mods.toml" \
  "${BUILD_DIR}/classes/META-INF/neoforge.mods.toml"

jar \
  --create \
  --file "${OUTPUT_PATH}" \
  -C "${BUILD_DIR}/classes" .

if jar --list --file "${OUTPUT_PATH}" | grep -q '^net/neoforged/'; then
  echo "ERROR: NeoForge compile stubが成果物へ混入しました" >&2
  exit 1
fi

if ! jar --list --file "${OUTPUT_PATH}" | grep -q '^META-INF/neoforge.mods.toml$'; then
  echo "ERROR: neoforge.mods.tomlが成果物にありません" >&2
  exit 1
fi

if jar --list --file "${OUTPUT_PATH}" | grep -q '^fabric.mod.json$'; then
  echo "ERROR: Fabric metadataが成果物に残っています" >&2
  exit 1
fi

if ! jar --list --file "${OUTPUT_PATH}" | grep -q '^jp/ivrm/metrics/IvrmMetricsBridge.class$'; then
  echo "ERROR: Metrics Bridge classが成果物にありません" >&2
  exit 1
fi

printf 'built=%s\n' "${OUTPUT_PATH}"
