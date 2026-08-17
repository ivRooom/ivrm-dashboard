#!/usr/bin/env python3
from __future__ import annotations

import grp
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MINECRAFT_BACKEND_CONTAINER = "mc-main"
BRIDGE_METRICS_PATH = "/data/ivrm/metrics.json"
DEFAULT_DOCKER_BINARY = "/usr/bin/docker"
DEFAULT_SNAPSHOT_PATH = "/run/ivrm-agent/docker-state.json"
MAX_SNAPSHOT_BYTES = 256 * 1024
MAX_COMMAND_OUTPUT_BYTES = 16 * 1024
MAX_TPS = 1_000.0
MAX_MSPT_MS = 60_000.0
MAX_METRICS_AGE_SECONDS = 45.0
MAX_FUTURE_SKEW_SECONDS = 5.0
COMMAND_TIMEOUT_SECONDS = 5

RFC3339_TIMESTAMP_PATTERN = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})"
    r"(?:\.(?P<fraction>\d{1,9}))?"
    r"(?P<timezone>Z|[+-]\d{2}:\d{2})$"
)

EXPECTED_METRICS_KEYS = {
    "generatedAt",
    "source",
    "tps1m",
    "tps5m",
    "tps15m",
    "msptMedian1m",
    "msptP95_1m",
    "msptMax1m",
}


def parse_boolean(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def parse_metric_number(value: object, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError("Metrics Bridgeの数値形式が不正です")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0 or parsed > maximum:
        raise RuntimeError("Metrics Bridgeの数値が許容範囲外です")
    return parsed


def parse_generated_at(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise RuntimeError("Metrics BridgeのgeneratedAtが不正です")

    match = RFC3339_TIMESTAMP_PATTERN.fullmatch(value)
    if match is None:
        raise RuntimeError("Metrics BridgeのgeneratedAt形式が不正です")

    fraction = match.group("fraction")
    fraction_part = ""
    if fraction is not None:
        # Java Instant may emit nanoseconds (up to 9 digits), while Python runtimes
        # used on Production may only accept microseconds. Truncate sub-microsecond
        # precision; freshness checks operate at second-level tolerances.
        fraction_part = f".{fraction[:6].ljust(6, '0')}"

    timezone_part = match.group("timezone")
    if timezone_part == "Z":
        timezone_part = "+00:00"

    normalized = f"{match.group('date')}{fraction_part}{timezone_part}"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise RuntimeError("Metrics BridgeのgeneratedAt形式が不正です") from exc
    return parsed.astimezone(timezone.utc)


def parse_bridge_metrics(output: str, now: datetime | None = None) -> dict[str, Any]:
    if not output or len(output.encode("utf-8")) > MAX_COMMAND_OUTPUT_BYTES:
        raise RuntimeError("Metrics Bridge出力サイズが不正です")
    try:
        document = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Metrics Bridge JSONが不正です") from exc
    if not isinstance(document, dict):
        raise RuntimeError("Metrics Bridge JSONがobjectではありません")
    if set(document) != EXPECTED_METRICS_KEYS:
        raise RuntimeError("Metrics Bridge JSONのkeyが不正です")
    if document.get("source") != "spark":
        raise RuntimeError("Metrics Bridge sourceが不正です")

    generated_at = parse_generated_at(document.get("generatedAt"))
    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_seconds = (observed_at - generated_at).total_seconds()
    if age_seconds < -MAX_FUTURE_SKEW_SECONDS:
        raise RuntimeError("Metrics Bridge時刻が未来です")
    if age_seconds > MAX_METRICS_AGE_SECONDS:
        raise RuntimeError("Metrics Bridgeデータが古すぎます")

    tps_1m = parse_metric_number(document.get("tps1m"), MAX_TPS)
    tps_5m = parse_metric_number(document.get("tps5m"), MAX_TPS)
    tps_15m = parse_metric_number(document.get("tps15m"), MAX_TPS)
    median = parse_metric_number(document.get("msptMedian1m"), MAX_MSPT_MS)
    percentile_95 = parse_metric_number(document.get("msptP95_1m"), MAX_MSPT_MS)
    maximum = parse_metric_number(document.get("msptMax1m"), MAX_MSPT_MS)
    if not median <= percentile_95 <= maximum:
        raise RuntimeError("Metrics Bridge MSPT値の順序が不正です")

    return {
        "source": "spark",
        "tps1m": tps_1m,
        "tps5m": tps_5m,
        "tps15m": tps_15m,
        "msptMedian1m": median,
        "msptP95_1m": percentile_95,
        "msptMax1m": maximum,
    }


def collect_spark_metrics(docker_binary: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [
                docker_binary,
                "exec",
                MINECRAFT_BACKEND_CONTAINER,
                "cat",
                BRIDGE_METRICS_PATH,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Metrics Bridgeファイルを取得できません") from exc

    if completed.returncode != 0:
        raise RuntimeError("Metrics Bridgeファイルを取得できません")
    return parse_bridge_metrics(completed.stdout)


def read_snapshot(path: Path) -> dict[str, Any]:
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise RuntimeError("Dockerスナップショットを読み込めません") from exc
    if not raw or len(raw) > MAX_SNAPSHOT_BYTES:
        raise RuntimeError("Dockerスナップショットのサイズが不正です")
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("DockerスナップショットJSONが不正です") from exc
    if not isinstance(document, dict):
        raise RuntimeError("DockerスナップショットJSONがobjectではありません")
    return document


def write_snapshot(path: Path, document: dict[str, Any]) -> None:
    encoded = (json.dumps(document, separators=(",", ":"), ensure_ascii=True) + "\n").encode(
        "utf-8"
    )
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise RuntimeError("更新後Dockerスナップショットが大きすぎます")

    group_id = grp.getgrnam("ivrm-agent").gr_gid
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="docker-state-performance-",
        suffix=".json",
        dir=path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        os.chown(temporary_path, 0, group_id)
        os.chmod(temporary_path, 0o640)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def augment_snapshot(path: Path, performance: dict[str, Any]) -> bool:
    document = read_snapshot(path)
    minecraft = document.get("minecraft")
    if not isinstance(minecraft, dict):
        return False
    minecraft["performance"] = performance
    write_snapshot(path, document)
    return True


def main() -> None:
    if not parse_boolean(os.environ.get("IVRM_MINECRAFT_PERFORMANCE_ENABLED")):
        return

    docker_binary = os.environ.get("IVRM_DOCKER_BINARY", DEFAULT_DOCKER_BINARY)
    snapshot_path = Path(
        os.environ.get("IVRM_DOCKER_SNAPSHOT_PATH", DEFAULT_SNAPSHOT_PATH)
    )
    if not snapshot_path.is_absolute():
        print("WARNING: Minecraft Performance設定が不正です", file=sys.stderr)
        return

    try:
        performance = collect_spark_metrics(docker_binary)
        augment_snapshot(snapshot_path, performance)
    except RuntimeError:
        # Metrics Bridgeが未導入・停止中・staleでも既存Status Probeを壊さない。
        # Bridge JSON本文はログへ転記せず、Performanceだけ欠損扱いにする。
        print("WARNING: Minecraft TPS/MSPTを取得できませんでした", file=sys.stderr)


if __name__ == "__main__":
    main()
