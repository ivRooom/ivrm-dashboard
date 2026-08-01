#!/usr/bin/env python3
"""許可済みDockerコンテナの状態と限定メトリクスをJSONへ書き出す。"""

from __future__ import annotations

import grp
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

CONTAINER_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
SIZE_PATTERN = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B|kB)$")
VALID_STATES = {
    "created",
    "running",
    "paused",
    "restarting",
    "removing",
    "exited",
    "dead",
}
VALID_HEALTH = {"starting", "healthy", "unhealthy"}
MAX_CONTAINERS = 20
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SIZE_MULTIPLIERS = {
    "B": 1,
    "kB": 1_000,
    "KB": 1_000,
    "MB": 1_000**2,
    "GB": 1_000**3,
    "TB": 1_000**4,
    "PB": 1_000**5,
    "EB": 1_000**6,
    "KiB": 1_024,
    "MiB": 1_024**2,
    "GiB": 1_024**3,
    "TiB": 1_024**4,
    "PiB": 1_024**5,
    "EiB": 1_024**6,
}


def required_container_names() -> list[str]:
    raw = os.environ.get("IVRM_DOCKER_CONTAINERS", "")
    names = [name.strip() for name in raw.split(",") if name.strip()]
    if not names:
        raise RuntimeError("IVRM_DOCKER_CONTAINERSが設定されていません")
    if len(names) > MAX_CONTAINERS:
        raise RuntimeError(f"監視コンテナ数は{MAX_CONTAINERS}件以下にしてください")
    if len(names) != len(set(names)):
        raise RuntimeError("監視コンテナ名が重複しています")
    invalid = [name for name in names if not CONTAINER_NAME_PATTERN.fullmatch(name)]
    if invalid:
        raise RuntimeError("不正なコンテナ名があります")
    return names


def empty_resource_metrics() -> dict[str, Any]:
    return {
        "cpuPercent": None,
        "memoryUsageBytes": None,
        "memoryLimitBytes": None,
        "networkRxBytes": None,
        "networkTxBytes": None,
        "blockReadBytes": None,
        "blockWriteBytes": None,
        "pids": None,
    }


def parse_size(value: str) -> int:
    match = SIZE_PATTERN.fullmatch(value.strip())
    if not match:
        raise ValueError(f"サイズ形式が不正です: {value!r}")

    number_text, unit = match.groups()
    try:
        result = int(Decimal(number_text) * SIZE_MULTIPLIERS[unit])
    except (InvalidOperation, KeyError) as exc:
        raise ValueError(f"サイズ形式が不正です: {value!r}") from exc

    if result < 0 or result > MAX_SAFE_INTEGER:
        raise ValueError(f"サイズが許容範囲外です: {value!r}")
    return result


def parse_size_pair(value: str) -> tuple[int, int]:
    parts = [part.strip() for part in value.split("/")]
    if len(parts) != 2:
        raise ValueError(f"サイズペア形式が不正です: {value!r}")
    return parse_size(parts[0]), parse_size(parts[1])


def parse_percent(value: str) -> float:
    text = value.strip()
    if not text.endswith("%"):
        raise ValueError(f"パーセント形式が不正です: {value!r}")
    try:
        result = float(Decimal(text[:-1]))
    except InvalidOperation as exc:
        raise ValueError(f"パーセント形式が不正です: {value!r}") from exc
    if result < 0 or result > 100_000:
        raise ValueError(f"パーセントが許容範囲外です: {value!r}")
    return result


def parse_pids(value: str) -> int:
    try:
        result = int(value.strip())
    except ValueError as exc:
        raise ValueError(f"PIDs形式が不正です: {value!r}") from exc
    if result < 0 or result > 2_147_483_647:
        raise ValueError(f"PIDsが許容範囲外です: {value!r}")
    return result


def collect_stats(docker_binary: str, name: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [docker_binary, "stats", "--no-stream", "--format", "{{json .}}", name],
            check=False,
            capture_output=True,
            text=True,
            timeout=12,
            env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"docker statsがタイムアウトしました: {name}") from exc

    if completed.returncode != 0:
        raise RuntimeError(f"docker statsに失敗しました: {name}")

    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError(f"docker statsの応答件数が不正です: {name}")

    try:
        stats = json.loads(lines[0])
        memory_usage, memory_limit = parse_size_pair(stats["MemUsage"])
        network_rx, network_tx = parse_size_pair(stats["NetIO"])
        block_read, block_write = parse_size_pair(stats["BlockIO"])
        cpu_percent = parse_percent(stats["CPUPerc"])
        pids = parse_pids(stats["PIDs"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"docker statsの応答形式が不正です: {name}") from exc

    if memory_usage > memory_limit:
        raise RuntimeError(f"docker statsのメモリ値が不正です: {name}")

    return {
        "cpuPercent": cpu_percent,
        "memoryUsageBytes": memory_usage,
        "memoryLimitBytes": memory_limit,
        "networkRxBytes": network_rx,
        "networkTxBytes": network_tx,
        "blockReadBytes": block_read,
        "blockWriteBytes": block_write,
        "pids": pids,
    }


def inspect_container(docker_binary: str, name: str) -> dict[str, Any]:
    completed = subprocess.run(
        [docker_binary, "inspect", name],
        check=False,
        capture_output=True,
        text=True,
        timeout=8,
        env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
    )

    if completed.returncode != 0:
        error_text = completed.stderr.lower()
        if "no such object" in error_text or "no such container" in error_text:
            return {
                "name": name,
                "state": "not_found",
                "health": "unknown",
                "restartCount": 0,
                "oomKilled": False,
                "exitCode": None,
                **empty_resource_metrics(),
            }
        raise RuntimeError(f"docker inspectに失敗しました: {name}")

    try:
        documents = json.loads(completed.stdout)
        document = documents[0]
        state_data = document["State"]
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as exc:
        raise RuntimeError(f"docker inspectの応答形式が不正です: {name}") from exc

    raw_state = state_data.get("Status")
    state = raw_state if raw_state in VALID_STATES else "unknown"

    health_data = state_data.get("Health")
    if isinstance(health_data, dict):
        raw_health = health_data.get("Status")
        health = raw_health if raw_health in VALID_HEALTH else "unknown"
    else:
        health = "none"

    restart_count = document.get("RestartCount", 0)
    if (
        not isinstance(restart_count, int)
        or isinstance(restart_count, bool)
        or restart_count < 0
    ):
        restart_count = 0

    oom_killed = state_data.get("OOMKilled") is True
    exit_code = state_data.get("ExitCode")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        exit_code = None

    resource_metrics = empty_resource_metrics()
    if state == "running":
        try:
            resource_metrics = collect_stats(docker_binary, name)
        except RuntimeError as exc:
            print(f"WARNING: {exc}", file=sys.stderr)

    return {
        "name": name,
        "state": state,
        "health": health,
        "restartCount": restart_count,
        "oomKilled": oom_killed,
        "exitCode": exit_code,
        **resource_metrics,
    }


def write_snapshot(output_path: Path, containers: list[dict[str, Any]]) -> None:
    output_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    payload = {
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "containers": containers,
    }

    group_id = grp.getgrnam("ivrm-agent").gr_gid
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="docker-state-",
        suffix=".json",
        dir=output_path.parent,
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(payload, file, separators=(",", ":"), ensure_ascii=True)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.chown(temporary_path, 0, group_id)
        os.chmod(temporary_path, 0o640)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    docker_binary = os.environ.get("IVRM_DOCKER_BINARY", "/usr/bin/docker")
    output_path = Path(
        os.environ.get(
            "IVRM_DOCKER_SNAPSHOT_PATH",
            "/run/ivrm-agent/docker-state.json",
        )
    )
    if not output_path.is_absolute():
        raise RuntimeError("IVRM_DOCKER_SNAPSHOT_PATHは絶対パスにしてください")

    containers = [
        inspect_container(docker_binary, name) for name in required_container_names()
    ]
    write_snapshot(output_path, containers)


if __name__ == "__main__":
    main()
