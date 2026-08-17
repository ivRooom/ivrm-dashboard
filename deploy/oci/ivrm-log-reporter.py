#!/usr/bin/env python3
"""IVRM Consoleへ安全に整形した短期ログを署名付きで送信する。"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Iterable

MAX_REPORT_BODY_BYTES = 64 * 1024
MAX_ENTRIES = 120
MAX_LINE_CHARACTERS = 2048
SOURCE_TIMEOUT_SECONDS = 4
DEFAULT_WINDOW_SECONDS = 20
MAX_WINDOW_SECONDS = 120

CONTAINER_SOURCES = (
    "mc-main",
    "mc-block",
    "ivrm-velocity",
    "mc-resource",
    "mc-resource-router",
)
SYSTEMD_SOURCES = ("ivrm-agent",)

ANSI_PATTERN = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
IPV4_PATTERN = re.compile(
    r"(?<![0-9.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![0-9.])"
)
IPV6_PATTERN = re.compile(
    r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])"
)
BEARER_PATTERN = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}")
SECRET_QUERY_PATTERN = re.compile(
    r"(?i)([?&](?:access[_-]?token|refresh[_-]?token|token|password|passwd|secret|rcon[_-]?password|forwarding[_-]?secret)=)[^&\s]+"
)
SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(authorization|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|rcon(?:[._-]?password)?|forwarding(?:[._-]?secret))\b(\s*[:=]\s*|\s+)([^\s,;]+)"
)
RFC3339_PATTERN = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?P<fraction>\.\d{1,9})?(?P<zone>Z|[+-]\d{2}:\d{2})$"
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def normalize_rfc3339(value: str) -> str | None:
    match = RFC3339_PATTERN.fullmatch(value.strip())
    if match is None:
        return None
    fraction = match.group("fraction")
    normalized_fraction = ""
    if fraction:
        digits = fraction[1:]
        normalized_fraction = "." + digits[:6].ljust(6, "0")
    normalized = f"{match.group('date')}{normalized_fraction}{match.group('zone')}"
    try:
        parsed = datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def redact_message(message: str) -> str:
    value = ANSI_PATTERN.sub("", message)
    value = "".join(char if char.isprintable() else " " for char in value)
    value = BEARER_PATTERN.sub("Bearer [REDACTED]", value)
    value = SECRET_QUERY_PATTERN.sub(r"\1[REDACTED]", value)
    value = SECRET_ASSIGNMENT_PATTERN.sub(r"\1\2[REDACTED]", value)
    value = IPV4_PATTERN.sub("[REDACTED_IP]", value)
    value = IPV6_PATTERN.sub("[REDACTED_IP]", value)
    value = " ".join(value.split())
    if len(value) > MAX_LINE_CHARACTERS:
        suffix = " … [truncated]"
        value = value[: MAX_LINE_CHARACTERS - len(suffix)] + suffix
    return value


def classify_level(message: str) -> str:
    upper = message.upper()
    if re.search(r"\b(?:FATAL|SEVERE)\b", upper):
        return "critical"
    if re.search(r"\bERROR\b|EXCEPTION|TRACEBACK", upper):
        return "error"
    if re.search(r"\bWARN(?:ING)?\b", upper):
        return "warning"
    if re.search(r"\bDEBUG\b", upper):
        return "debug"
    return "info"


def docker_log_entries(container_name: str, window_seconds: int) -> list[dict[str, str]]:
    command = [
        "/usr/bin/docker",
        "logs",
        "--timestamps",
        f"--since={window_seconds}s",
        "--tail=100",
        container_name,
    ]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SOURCE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []

    entries: list[dict[str, str]] = []
    for raw_line in result.stdout.splitlines():
        timestamp, separator, raw_message = raw_line.partition(" ")
        if not separator:
            continue
        observed_at = normalize_rfc3339(timestamp)
        if observed_at is None:
            continue
        message = redact_message(raw_message)
        if not message:
            continue
        entries.append(
            {
                "sourceType": "container",
                "sourceName": container_name,
                "observedAt": observed_at,
                "level": classify_level(message),
                "message": message,
            }
        )
    return entries


def systemd_log_entries(unit_name: str, window_seconds: int) -> list[dict[str, str]]:
    command = [
        "/usr/bin/journalctl",
        "--unit",
        unit_name,
        "--since",
        f"-{window_seconds} seconds",
        "--output=json",
        "--no-pager",
        "--lines=100",
    ]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=SOURCE_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0:
        return []

    entries: list[dict[str, str]] = []
    for raw_line in result.stdout.splitlines():
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        message_value = record.get("MESSAGE")
        realtime_value = record.get("__REALTIME_TIMESTAMP")
        if not isinstance(message_value, str) or not isinstance(realtime_value, str) or not realtime_value.isdigit():
            continue
        try:
            observed = datetime.fromtimestamp(int(realtime_value) / 1_000_000, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            continue
        message = redact_message(message_value)
        if not message:
            continue
        entries.append(
            {
                "sourceType": "systemd",
                "sourceName": unit_name,
                "observedAt": observed.isoformat(timespec="microseconds").replace("+00:00", "Z"),
                "level": classify_level(message),
                "message": message,
            }
        )
    return entries


def collect_entries(window_seconds: int) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for source in CONTAINER_SOURCES:
        entries.extend(docker_log_entries(source, window_seconds))
    for source in SYSTEMD_SOURCES:
        entries.extend(systemd_log_entries(source, window_seconds))
    entries.sort(key=lambda entry: (entry["observedAt"], entry["sourceType"], entry["sourceName"], entry["message"]))
    if len(entries) > MAX_ENTRIES:
        entries = entries[-MAX_ENTRIES:]
    return entries


def encode_body(server_id: str, entries: Iterable[dict[str, str]], reported_at: str | None = None) -> bytes:
    if not server_id or len(server_id) > 64 or re.fullmatch(r"[A-Za-z0-9._-]+", server_id) is None:
        raise ValueError("IVRM_AGENT_SERVER_IDが不正です")
    report_time = reported_at or utc_now_iso()
    accepted = list(entries)[-MAX_ENTRIES:]
    while accepted:
        payload = {"serverId": server_id, "reportedAt": report_time, "entries": accepted}
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(body) <= MAX_REPORT_BODY_BYTES:
            return body
        accepted.pop(0)
    raise ValueError("Log Reportを上限内へ収められませんでした")


def sign(secret: bytes, timestamp: str, nonce: str, body: bytes) -> str:
    return hmac.new(
        secret,
        timestamp.encode("ascii") + b"." + nonce.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()


def validate_endpoint(endpoint: str) -> None:
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.username is not None or parsed.password is not None or not parsed.hostname:
        raise ValueError("Log Endpointが不正です")
    if parsed.scheme == "https":
        return
    if parsed.scheme != "http":
        raise ValueError("Log EndpointはHTTPSを使用してください")
    if parsed.hostname == "localhost":
        return
    try:
        if ipaddress.ip_address(parsed.hostname).is_loopback:
            return
    except ValueError:
        pass
    raise ValueError("HTTPはlocalhostまたはloopback IPでのみ使用できます")


def send_report(endpoint: str, server_id: str, secret: str, body: bytes) -> int:
    validate_endpoint(endpoint)
    if len(secret) < 32:
        raise ValueError("IVRM_AGENT_TOKENは32文字以上が必要です")
    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "ivrm-log-reporter/1.0.0",
            "X-IVRM-Agent-ID": server_id,
            "X-IVRM-Timestamp": timestamp,
            "X-IVRM-Nonce": nonce,
            "X-IVRM-Signature": sign(secret.encode("utf-8"), timestamp, nonce, body),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def configured_window_seconds() -> int:
    raw = os.environ.get("IVRM_LOG_REPORT_WINDOW_SECONDS", str(DEFAULT_WINDOW_SECONDS)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("IVRM_LOG_REPORT_WINDOW_SECONDSが不正です") from exc
    if value < 5 or value > MAX_WINDOW_SECONDS:
        raise ValueError("IVRM_LOG_REPORT_WINDOW_SECONDSは5〜120秒にしてください")
    return value


def enabled() -> bool:
    value = os.environ.get("IVRM_LOG_REPORTING_ENABLED", "false").strip().lower()
    if value not in {"true", "false"}:
        raise ValueError("IVRM_LOG_REPORTING_ENABLEDはtrue/falseで指定してください")
    return value == "true"


def main() -> int:
    try:
        if not enabled():
            return 0
        server_id = os.environ.get("IVRM_AGENT_SERVER_ID", "").strip()
        endpoint = os.environ.get("IVRM_AGENT_LOG_ENDPOINT", "").strip()
        secret = os.environ.get("IVRM_AGENT_TOKEN", "")
        if not server_id or not endpoint or not secret:
            print("Log Reporter設定が不足しています", file=sys.stderr)
            return 2

        entries = collect_entries(configured_window_seconds())
        if not entries:
            return 0
        body = encode_body(server_id, entries)
        status = send_report(endpoint, server_id, secret, body)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(f"Log Report送信に失敗しました: {exc}", file=sys.stderr)
        return 1

    if 200 <= status < 300:
        return 0
    print(f"Log Report APIがエラーを返しました: status={status}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
