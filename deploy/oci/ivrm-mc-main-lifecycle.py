#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

CONTAINER = "mc-main"
WORK_DIR = Path("/run/ivrm-agent/operations")
REQUEST_DIR = WORK_DIR / "requests"
RESULT_DIR = WORK_DIR / "results"
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
ACTIONS = {"start_backend", "restart_backend", "stop_backend"}
START_TIMEOUT_SECONDS = 120
STOP_TIMEOUT_SECONDS = 60
REQUEST_MAX_AGE_SECONDS = 30
RESULT_RETENTION_SECONDS = 24 * 60 * 60


def execution_enabled() -> bool:
    return os.environ.get("IVRM_OPERATION_EXECUTION_ENABLED", "false").strip().lower() == "true"


def run_docker(*args: str, timeout: int = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["/usr/bin/docker", *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def inspect_state() -> tuple[str, str]:
    result = run_docker(
        "inspect",
        "--format",
        "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
        CONTAINER,
    )
    if result.returncode != 0:
        return "not_found", "unknown"
    raw = result.stdout.strip()
    if "|" not in raw:
        return "unknown", "unknown"
    state, health = raw.split("|", 1)
    return state.strip(), health.strip()


def wait_stopped(timeout_seconds: int = STOP_TIMEOUT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        state, _ = inspect_state()
        if state in {"exited", "dead", "created", "not_found"}:
            return True
        time.sleep(1)
    return False


def wait_healthy(timeout_seconds: int = START_TIMEOUT_SECONDS) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        state, health = inspect_state()
        if state == "running" and health == "healthy":
            return True
        if state in {"exited", "dead", "not_found"}:
            return False
        time.sleep(2)
    return False


def graceful_stop() -> tuple[bool, str]:
    state, _ = inspect_state()
    if state in {"exited", "dead", "created", "not_found"}:
        return True, "stopped"
    result = run_docker("kill", "--signal=TERM", CONTAINER)
    if result.returncode != 0:
        return False, "docker_term_failed"
    if not wait_stopped():
        return False, "graceful_stop_timeout"
    return True, "stopped"


def safe_start() -> tuple[bool, str]:
    state, health = inspect_state()
    if state == "running" and health == "healthy":
        return True, "health_gate_passed"
    if state == "running" and health != "healthy":
        return False, "preexisting_unhealthy"
    result = run_docker("start", CONTAINER)
    if result.returncode != 0:
        return False, "docker_start_failed"
    if not wait_healthy():
        return False, "health_gate_failed"
    return True, "health_gate_passed"


def execute(action: str) -> tuple[bool, str, str | None]:
    if action == "start_backend":
        ok, value = safe_start()
        return ok, value if ok else "execution_failed", None if ok else value
    if action == "stop_backend":
        ok, value = graceful_stop()
        return ok, "stopped" if ok else "execution_failed", None if ok else value
    if action == "restart_backend":
        ok, value = graceful_stop()
        if not ok:
            return False, "execution_failed", value
        ok, value = safe_start()
        return ok, value if ok else "execution_failed", None if ok else value
    return False, "execution_failed", "action_not_allowed"


def validate_request_file(path: Path) -> None:
    stat = path.stat()
    if stat.st_mode & 0o077:
        raise ValueError("invalid_request_permissions")
    age = time.time() - stat.st_mtime
    if age < -5 or age > REQUEST_MAX_AGE_SECONDS:
        raise ValueError("stale_request")


def parse_request(path: Path) -> tuple[str, str]:
    if not UUID_RE.fullmatch(path.stem):
        raise ValueError("invalid_job_id")
    validate_request_file(path)
    raw = path.read_bytes()
    if len(raw) > 1024:
        raise ValueError("request_too_large")
    document = json.loads(raw.decode("utf-8"))
    if not isinstance(document, dict) or set(document) != {"jobId", "action"}:
        raise ValueError("invalid_payload")
    job_id = document.get("jobId")
    action = document.get("action")
    if job_id != path.stem or not isinstance(job_id, str) or not UUID_RE.fullmatch(job_id):
        raise ValueError("invalid_job_id")
    if action not in ACTIONS:
        raise ValueError("action_not_allowed")
    return job_id, action


def write_result(job_id: str, action: str, ok: bool, phase: str, error_code: str | None) -> None:
    result_path = RESULT_DIR / f"{job_id}.json"
    temp_path = RESULT_DIR / f".{job_id}.{os.getpid()}.tmp"
    document: dict[str, object] = {"jobId": job_id, "action": action, "ok": ok, "phase": phase}
    if error_code:
        document["errorCode"] = error_code
    temp_path.write_text(json.dumps(document, separators=(",", ":")), encoding="utf-8")
    os.chmod(temp_path, 0o640)
    os.replace(temp_path, result_path)


def cleanup_old_results(now: float | None = None) -> None:
    cutoff = (time.time() if now is None else now) - RESULT_RETENTION_SECONDS
    for path in RESULT_DIR.glob("*.json"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink(missing_ok=True)
        except OSError:
            continue


def process_request(path: Path) -> None:
    try:
        job_id, action = parse_request(path)
    except Exception:
        path.unlink(missing_ok=True)
        return

    try:
        ok, phase, error_code = execute(action)
        write_result(job_id, action, ok, phase, error_code)
    except Exception:
        write_result(job_id, action, False, "execution_failed", "executor_internal_error")
    finally:
        path.unlink(missing_ok=True)


def main() -> int:
    if not execution_enabled():
        return 0
    if not REQUEST_DIR.is_dir() or not RESULT_DIR.is_dir():
        return 1
    cleanup_old_results()
    for path in sorted(REQUEST_DIR.glob("*.json"))[:8]:
        process_request(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
