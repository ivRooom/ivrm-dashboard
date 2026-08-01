#!/usr/bin/env python3
"""許可済みDockerコンテナの限定状態だけをJSONへ書き出す。"""

from __future__ import annotations

import grp
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONTAINER_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
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

    return {
        "name": name,
        "state": state,
        "health": health,
        "restartCount": restart_count,
        "oomKilled": oom_killed,
        "exitCode": exit_code,
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
