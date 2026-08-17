#!/usr/bin/env python3
from __future__ import annotations

import grp
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

MINECRAFT_BACKEND_CONTAINER = "mc-main"
DEFAULT_DOCKER_BINARY = "/usr/bin/docker"
DEFAULT_SNAPSHOT_PATH = "/run/ivrm-agent/docker-state.json"
MAX_SNAPSHOT_BYTES = 256 * 1024
MAX_COMMAND_OUTPUT_BYTES = 16 * 1024
MAX_TPS = 1_000.0
MAX_MSPT_MS = 60_000.0
COMMAND_TIMEOUT_SECONDS = 5

ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
MINECRAFT_FORMAT = re.compile(r"§[0-9A-FK-ORa-fk-or]")
RESPONSE_PREFIX = re.compile(r"^\[[^\]\r\n]{1,32}\]\s*")
TPS_HEADER = re.compile(
    r"TPS\s+from\s+last\s+5s,\s*10s,\s*1m,\s*5m,\s*15m:",
    re.IGNORECASE,
)
MSPT_HEADER = re.compile(
    r"Tick\s+durations\s*\(min/med/95%ile/max\s+ms\)\s+from\s+last\s+10s,\s*1m:",
    re.IGNORECASE,
)
NUMBER = re.compile(r"^\*?([0-9]+(?:\.[0-9]+)?)$")


def parse_boolean(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes", "on"}


def clean_output(value: str) -> str:
    return MINECRAFT_FORMAT.sub("", ANSI_ESCAPE.sub("", value)).replace("\r", "")


def normalize_line(value: str) -> str:
    return RESPONSE_PREFIX.sub("", value.strip()).strip()


def parse_number(value: str, maximum: float) -> float:
    match = NUMBER.fullmatch(value.strip())
    if not match:
        raise RuntimeError("Sparkメトリクスの数値形式が不正です")
    parsed = float(match.group(1))
    if parsed < 0 or parsed > maximum:
        raise RuntimeError("Sparkメトリクスが許容範囲外です")
    return parsed


def next_value_line(lines: list[str], start: int) -> str:
    for line in lines[start:]:
        if line:
            return line
    raise RuntimeError("Sparkメトリクス値がありません")


def parse_spark_tps_output(output: str) -> dict[str, Any]:
    lines = [normalize_line(line) for line in clean_output(output).splitlines()]
    tps_line: str | None = None
    mspt_line: str | None = None

    for index, line in enumerate(lines):
        if tps_line is None and TPS_HEADER.search(line):
            tps_line = next_value_line(lines, index + 1)
        if mspt_line is None and MSPT_HEADER.search(line):
            mspt_line = next_value_line(lines, index + 1)

    if tps_line is None or mspt_line is None:
        raise RuntimeError("Spark TPS/MSPT出力を認識できません")

    tps_values = [part.strip() for part in tps_line.split(",")]
    if len(tps_values) != 5:
        raise RuntimeError("Spark TPS値の個数が不正です")
    tps_1m = parse_number(tps_values[2], MAX_TPS)
    tps_5m = parse_number(tps_values[3], MAX_TPS)
    tps_15m = parse_number(tps_values[4], MAX_TPS)

    windows = [part.strip() for part in mspt_line.split(";")]
    if len(windows) != 2:
        raise RuntimeError("Spark MSPT windowの個数が不正です")
    one_minute = [part.strip() for part in windows[1].split("/")]
    if len(one_minute) != 4:
        raise RuntimeError("Spark MSPT値の個数が不正です")

    minimum = parse_number(one_minute[0], MAX_MSPT_MS)
    median = parse_number(one_minute[1], MAX_MSPT_MS)
    percentile_95 = parse_number(one_minute[2], MAX_MSPT_MS)
    maximum = parse_number(one_minute[3], MAX_MSPT_MS)
    if not minimum <= median <= percentile_95 <= maximum:
        raise RuntimeError("Spark MSPT値の順序が不正です")

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
                "rcon-cli",
                "spark",
                "tps",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Sparkメトリクスコマンドを実行できません") from exc

    if completed.returncode != 0:
        raise RuntimeError("Sparkメトリクスコマンドが失敗しました")
    if len(completed.stdout.encode("utf-8")) > MAX_COMMAND_OUTPUT_BYTES:
        raise RuntimeError("Sparkメトリクス出力が大きすぎます")
    return parse_spark_tps_output(completed.stdout)


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
        # Spark/RCONが未導入・停止中でも既存Status Probeを壊さない。
        # RCONのstderr/stdoutは資格情報や運用情報を含み得るためログへ転記しない。
        print("WARNING: Minecraft TPS/MSPTを取得できませんでした", file=sys.stderr)


if __name__ == "__main__":
    main()
