#!/usr/bin/env python3
"""IVRM Dashboard 予備 ingest 受信サービス (ingest-relay).

Console (Vercel) が停止しても監視 ingest が止まらないよう、DB ホスト上で
tailnet 限定で待ち受ける予備の受け口。認証 (HMAC) と DB 書込み (PostgREST RPC)
は本系の Web 実装 (apps/web/lib/operation-agent-auth-core.ts ほか) と同一仕様で、
永続化は同じ DB 関数 (insert_agent_heartbeat_v3 / ingest_cloud_monitor_v1 /
ingest_backup_report_v1 / ingest_console_log_report_v1 / ingest_runtime_inventory_v1) に委ねる。

依存は Python 標準ライブラリのみ。

環境変数:
  IVRM_RELAY_BIND            待ち受けアドレス "host:port" (tailnet IP を指定する)
  IVRM_RELAY_SECRETS_FILE    serverId -> secret の JSON ファイルへのパス
  IVRM_RELAY_POSTGREST_URL   PostgREST のベース URL (例: https://api.ivrm.jp/dash/rest/v1)
  IVRM_RELAY_SERVICE_KEY     PostgREST の service role key
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_CLOCK_SKEW_SECONDS = 300

ROUTES = {
    "/api/agent/heartbeat": {
        "rpc": "insert_agent_heartbeat_v3",
        "max_bytes": 32 * 1024,
        "storage_error": "storage_unavailable",
    },
    "/api/agent/cloud": {
        "rpc": "ingest_cloud_monitor_v1",
        "max_bytes": 16 * 1024,
        "storage_error": "store_unavailable",
    },
    "/api/agent/backups": {
        "rpc": "ingest_backup_report_v1",
        "max_bytes": 32 * 1024,
        "storage_error": "storage_unavailable",
    },
    "/api/agent/logs": {
        "rpc": "ingest_console_log_report_v1",
        "max_bytes": 64 * 1024,
        "storage_error": "storage_unavailable",
    },
    "/api/agent/runtime": {
        "rpc": "ingest_runtime_inventory_v1",
        "max_bytes": 32 * 1024,
        "storage_error": "store_unavailable",
    },
}

PERSIST_RESULT_STATUS = {
    "unknown_agent": 401,
    "target_not_allowed": 403,
    "rate_limited": 429,
    "replayed_request": 409,
    "invalid_payload": 400,
}

SERVER_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
TIMESTAMP_PATTERN = re.compile(r"^\d{10}$")
NONCE_PATTERN = re.compile(r"^[a-f0-9]{32}$")
SIGNATURE_PATTERN = re.compile(r"^[a-f0-9]{64}$")

HEARTBEAT_HOST_PARAMS = {
    "cpuCount": "p_cpu_count",
    "memoryTotalBytes": "p_memory_total_bytes",
    "memoryAvailableBytes": "p_memory_available_bytes",
    "diskTotalBytes": "p_disk_total_bytes",
    "diskAvailableBytes": "p_disk_available_bytes",
    "loadAverage1": "p_load_average_1",
    "loadAverage5": "p_load_average_5",
    "loadAverage15": "p_load_average_15",
    "uptimeSeconds": "p_uptime_seconds",
}


class RelayError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


class Config:
    def __init__(self) -> None:
        self.bind = os.environ.get("IVRM_RELAY_BIND", "").strip()
        secrets_file = os.environ.get("IVRM_RELAY_SECRETS_FILE", "").strip()
        self.postgrest_url = os.environ.get("IVRM_RELAY_POSTGREST_URL", "").strip().rstrip("/")
        self.service_key = os.environ.get("IVRM_RELAY_SERVICE_KEY", "").strip()
        if not self.bind or ":" not in self.bind:
            raise ValueError("IVRM_RELAY_BIND (host:port) が必要です")
        if not self.postgrest_url or not self.service_key:
            raise ValueError("IVRM_RELAY_POSTGREST_URL と IVRM_RELAY_SERVICE_KEY が必要です")
        if not secrets_file:
            raise ValueError("IVRM_RELAY_SECRETS_FILE が必要です")
        with open(secrets_file, encoding="utf-8") as handle:
            secrets = json.load(handle)
        if not isinstance(secrets, dict) or not secrets:
            raise ValueError("secrets ファイルは serverId -> secret の JSON オブジェクトが必要です")
        for server_id, secret in secrets.items():
            if not SERVER_ID_PATTERN.match(server_id) or not isinstance(secret, str) or len(secret) < 32:
                raise ValueError(f"secrets ファイルのエントリが不正です: {server_id!r}")
        self.secrets: dict[str, str] = secrets


def authenticate(headers, raw_body: bytes, expected_server_id: str, secrets: dict[str, str]) -> tuple[str, str]:
    """本系 operation-agent-auth-core.ts の authenticateOperationAgentWithSecrets と同一仕様。"""
    server_id = headers.get("x-ivrm-agent-id") or ""
    timestamp = headers.get("x-ivrm-timestamp") or ""
    nonce = headers.get("x-ivrm-nonce") or ""
    signature = headers.get("x-ivrm-signature") or ""

    if server_id != expected_server_id or not SERVER_ID_PATTERN.match(server_id):
        raise RelayError(401, "agent_id_mismatch")
    if not TIMESTAMP_PATTERN.match(timestamp):
        raise RelayError(401, "invalid_timestamp")
    if abs(time.time() - int(timestamp)) > MAX_CLOCK_SKEW_SECONDS:
        raise RelayError(401, "expired_request")
    if not NONCE_PATTERN.match(nonce):
        raise RelayError(401, "invalid_nonce")
    if not SIGNATURE_PATTERN.match(signature):
        raise RelayError(401, "invalid_signature")

    secret = secrets.get(server_id)
    if secret is None:
        raise RelayError(401, "unknown_agent")
    expected = hmac.new(
        secret.encode("utf-8"),
        timestamp.encode("utf-8") + b"." + nonce.encode("utf-8") + b"." + raw_body,
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(bytes.fromhex(signature), expected):
        raise RelayError(401, "invalid_signature")
    return nonce, hashlib.sha256(raw_body).hexdigest()


# --- Web 側 parse の移植 (apps/web/lib/log-report.ts / backup-report.ts) ---
# DB 関数は Web が正規化した形を前提に検証するため、relay でも同じ正規化を行う。

LOG_SOURCES = {
    "mc-main": "container",
    "mc-block": "container",
    "ivrm-velocity": "container",
    "mc-resource": "container",
    "mc-resource-router": "container",
    "ivrm-agent": "systemd",
}
LOG_LEVELS = {"debug", "info", "warning", "error", "critical"}
LOG_REPORT_KEYS = {"serverId", "reportedAt", "entries"}
LOG_ENTRY_KEYS = {"sourceType", "sourceName", "observedAt", "level", "message"}
RFC3339_MICRO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
MAX_LOG_ENTRIES = 120
MAX_LOG_MESSAGE = 2048
MAX_LOG_RAW_MESSAGE = 4096

_ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_MC_FORMAT = re.compile(r"§[0-9A-FK-ORX]", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}", re.IGNORECASE)
_SECRET_WORDS = r"(?:access[_-]?token|refresh[_-]?token|token|password|passwd|secret|rcon[_-]?password|forwarding[_-]?secret)"
_SECRET_QUERY = re.compile(r"([?&]" + _SECRET_WORDS + r"=)[^&\s]+", re.IGNORECASE)
_SECRET_QUOTED = re.compile(
    r"\b(authorization|" + _SECRET_WORDS + r")\b([\"']?)(\s*[:=]\s*|\s+)([\"'])([^\"']*)\4", re.IGNORECASE
)
_SECRET_ASSIGN = re.compile(
    r"\b(authorization|" + _SECRET_WORDS + r")\b([\"']?)(\s*[:=]\s*|\s+)([^\s,;}\"']+)", re.IGNORECASE
)
_IPV4 = re.compile(r"(?<![0-9.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![0-9.])")
_IPV6 = re.compile(r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])")
_IPV6_CANDIDATE = re.compile(r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])")


def _is_ipv6(text: str) -> bool:
    try:
        return isinstance(ipaddress.ip_address(text), ipaddress.IPv6Address)
    except ValueError:
        return False


def redact_log_message(message: str) -> str:
    text = _ANSI.sub("", message)
    text = _MC_FORMAT.sub("", text)
    text = _CONTROL.sub(" ", text)
    text = _BEARER.sub("Bearer [REDACTED]", text)
    text = _SECRET_QUERY.sub(r"\1[REDACTED]", text)
    text = _SECRET_QUOTED.sub(lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}{m.group(4)}[REDACTED]{m.group(4)}", text)
    text = _SECRET_ASSIGN.sub(r"\1\2\3[REDACTED]", text)
    text = _IPV4.sub("[REDACTED_IP]", text)
    text = _IPV6.sub("[REDACTED_IP]", text)
    text = _IPV6_CANDIDATE.sub(lambda m: "[REDACTED_IP]" if _is_ipv6(m.group(0)) else m.group(0), text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_LOG_MESSAGE]


def parse_timestamp_ms(value: str) -> float | None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def normalize_log_entries(payload: dict) -> list:
    if set(payload.keys()) != LOG_REPORT_KEYS:
        raise RelayError(400, "invalid_payload")
    reported_at = payload.get("reportedAt")
    entries = payload.get("entries")
    if not isinstance(reported_at, str) or not RFC3339_MICRO.match(reported_at):
        raise RelayError(400, "invalid_payload")
    if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_LOG_ENTRIES:
        raise RelayError(400, "invalid_payload")
    reported_ms = parse_timestamp_ms(reported_at)
    if reported_ms is None or abs(time.time() * 1000 - reported_ms) > MAX_CLOCK_SKEW_SECONDS * 1000:
        raise RelayError(401, "expired_request")
    normalized_by_id: dict[str, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry.keys()) != LOG_ENTRY_KEYS:
            raise RelayError(400, "invalid_payload")
        source_type = entry.get("sourceType")
        source_name = entry.get("sourceName")
        observed_at = entry.get("observedAt")
        level = entry.get("level")
        message = entry.get("message")
        if (
            not isinstance(source_name, str)
            or LOG_SOURCES.get(source_name) is None
            or LOG_SOURCES[source_name] != source_type
            or not isinstance(observed_at, str)
            or not RFC3339_MICRO.match(observed_at)
            or level not in LOG_LEVELS
            or not isinstance(message, str)
            or not 1 <= len(message) <= MAX_LOG_RAW_MESSAGE
        ):
            raise RelayError(400, "invalid_payload")
        observed_ms = parse_timestamp_ms(observed_at)
        if observed_ms is None or abs(observed_ms - reported_ms) > MAX_CLOCK_SKEW_SECONDS * 1000:
            raise RelayError(400, "invalid_payload")
        redacted = redact_log_message(message)
        if not redacted:
            raise RelayError(400, "invalid_payload")
        normalized = {
            "sourceType": LOG_SOURCES[source_name],
            "sourceName": source_name,
            "observedAt": observed_at,
            "level": level,
            "message": redacted,
        }
        # eventId は Web と同一: sourceType \0 sourceName \0 observedAt \0 message の sha256
        event_material = "\x00".join(
            [normalized["sourceType"], normalized["sourceName"], normalized["observedAt"], normalized["message"]]
        )
        normalized["eventId"] = hashlib.sha256(event_material.encode("utf-8")).hexdigest()
        normalized_by_id.setdefault(normalized["eventId"], normalized)
    return list(normalized_by_id.values())


BACKUP_TYPES = {"world", "config", "permissions", "full"}
BACKUP_DESTINATIONS = {"local", "s3"}
BACKUP_OUTCOMES = {"success", "failed", "running", "unknown"}
BACKUP_FAILURE_CODES = {
    "source_unavailable",
    "archive_failed",
    "checksum_failed",
    "remote_sync_failed",
    "retention_failed",
    "timeout",
    "permission_denied",
    "insufficient_space",
    "unknown",
}
BACKUP_REPORT_KEYS = {"serverId", "reportedAt", "runs"}
BACKUP_RUN_KEYS = {
    "runId",
    "backupTarget",
    "gameMode",
    "backupType",
    "destinationType",
    "startedAt",
    "completedAt",
    "outcome",
    "durationSeconds",
    "sizeBytes",
    "sha256Verified",
    "remoteSyncedAt",
    "restoreTestedAt",
    "retentionExpiresAt",
    "failureCode",
}
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
MAX_BACKUP_RUNS = 20
MAX_DURATION_SECONDS = 7 * 24 * 60 * 60
MAX_SAFE_INTEGER = 2**53 - 1


def _nullable_timestamp(value) -> tuple[bool, str | None]:
    if value is None:
        return True, None
    if not isinstance(value, str) or parse_timestamp_ms(value) is None:
        return False, None
    return True, value


def _nullable_safe_int(value, maximum: int) -> tuple[bool, int | None]:
    if value is None:
        return True, None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
        return False, None
    return True, value


def normalize_backup_runs(payload: dict) -> list:
    if set(payload.keys()) != BACKUP_REPORT_KEYS:
        raise RelayError(400, "invalid_payload")
    reported_at = payload.get("reportedAt")
    runs = payload.get("runs")
    if not isinstance(reported_at, str) or parse_timestamp_ms(reported_at) is None:
        raise RelayError(400, "invalid_payload")
    if not isinstance(runs, list) or not 1 <= len(runs) <= MAX_BACKUP_RUNS:
        raise RelayError(400, "invalid_payload")
    reported_ms = parse_timestamp_ms(reported_at)
    if abs(time.time() * 1000 - reported_ms) > MAX_CLOCK_SKEW_SECONDS * 1000:
        raise RelayError(401, "expired_request")
    normalized_runs = []
    seen_ids = set()
    for run in runs:
        if not isinstance(run, dict) or not set(run.keys()) <= BACKUP_RUN_KEYS:
            raise RelayError(400, "invalid_payload")
        ok_completed, completed_at = _nullable_timestamp(run.get("completedAt"))
        ok_remote, remote_synced_at = _nullable_timestamp(run.get("remoteSyncedAt"))
        ok_restore, restore_tested_at = _nullable_timestamp(run.get("restoreTestedAt"))
        ok_retention, retention_expires_at = _nullable_timestamp(run.get("retentionExpiresAt"))
        ok_duration, duration_seconds = _nullable_safe_int(run.get("durationSeconds"), MAX_DURATION_SECONDS)
        ok_size, size_bytes = _nullable_safe_int(run.get("sizeBytes"), MAX_SAFE_INTEGER)
        started_at = run.get("startedAt")
        failure_code = run.get("failureCode")
        sha_verified = run.get("sha256Verified")
        if (
            not isinstance(run.get("runId"), str)
            or not UUID_PATTERN.match(run["runId"])
            or not isinstance(run.get("backupTarget"), str)
            or not IDENTIFIER_PATTERN.match(run["backupTarget"])
            or not isinstance(run.get("gameMode"), str)
            or not IDENTIFIER_PATTERN.match(run["gameMode"])
            or run.get("backupType") not in BACKUP_TYPES
            or run.get("destinationType") not in BACKUP_DESTINATIONS
            or not isinstance(started_at, str)
            or parse_timestamp_ms(started_at) is None
            or not (ok_completed and ok_remote and ok_restore and ok_retention and ok_duration and ok_size)
            or run.get("outcome") not in BACKUP_OUTCOMES
            or (sha_verified is not None and not isinstance(sha_verified, bool))
            or (failure_code is not None and failure_code not in BACKUP_FAILURE_CODES)
        ):
            raise RelayError(400, "invalid_payload")
        outcome = run["outcome"]
        started_ms = parse_timestamp_ms(started_at)
        completed_ms = parse_timestamp_ms(completed_at) if completed_at else None
        remote_ms = parse_timestamp_ms(remote_synced_at) if remote_synced_at else None
        restore_ms = parse_timestamp_ms(restore_tested_at) if restore_tested_at else None
        retention_ms = parse_timestamp_ms(retention_expires_at) if retention_expires_at else None
        if (
            started_ms > reported_ms + MAX_CLOCK_SKEW_SECONDS * 1000
            or started_ms < reported_ms - 90 * 24 * 60 * 60 * 1000
            or (outcome in ("success", "failed") and (completed_ms is None or duration_seconds is None))
            or (outcome in ("running", "unknown") and (completed_ms is not None or duration_seconds is not None))
            or (completed_ms is not None and (completed_ms < started_ms or completed_ms > reported_ms + MAX_CLOCK_SKEW_SECONDS * 1000))
            or (outcome == "failed" and failure_code is None)
            or (outcome != "failed" and failure_code is not None)
            or (remote_ms is not None and (completed_ms is None or remote_ms < completed_ms or remote_ms > reported_ms + MAX_CLOCK_SKEW_SECONDS * 1000))
            or (restore_ms is not None and (completed_ms is None or restore_ms < completed_ms or restore_ms > reported_ms + MAX_CLOCK_SKEW_SECONDS * 1000))
            or (retention_ms is not None and (completed_ms is None or retention_ms <= completed_ms))
        ):
            raise RelayError(400, "invalid_payload")
        if run["runId"] in seen_ids:
            raise RelayError(400, "duplicate_run_id")
        seen_ids.add(run["runId"])
        normalized_runs.append(
            {
                "runId": run["runId"],
                "backupTarget": run["backupTarget"],
                "gameMode": run["gameMode"],
                "backupType": run["backupType"],
                "destinationType": run["destinationType"],
                "startedAt": started_at,
                "completedAt": completed_at,
                "outcome": outcome,
                "durationSeconds": duration_seconds,
                "sizeBytes": size_bytes,
                "sha256Verified": sha_verified,
                "remoteSyncedAt": remote_synced_at,
                "restoreTestedAt": restore_tested_at,
                "retentionExpiresAt": retention_expires_at,
                "failureCode": failure_code,
            }
        )
    return normalized_runs


# --- Web 側 parse の移植 (apps/web/lib/runtime-inventory-core.ts) ---

RUNTIME_CONTAINERS = {
    "aws-app-01": ["ivrm-admin", "ivrm-api", "ivrm-home", "ivrm-member", "ivrm-contact", "ivrm-cloudflared", "ivrm-runtime-caddy", "ivrm-runtime-health"],
    "lightsail-herta": ["herta-api-1", "herta-studio-1", "herta-worker-1", "herta-bot-1", "herta-postgres-1", "herta-redis-1", "herta-caddy-1", "herta-nginx-1"],
    "oci-minecraft-01": ["mc-main", "ivrm-velocity", "mc-resource-router", "ivrm-status-api", "caddy"],
}
RUNTIME_STATES = {"created", "running", "paused", "restarting", "removing", "exited", "dead"}
RUNTIME_HEALTHS = {"starting", "healthy", "unhealthy", "none"}
RUNTIME_OK_KEYS = {"collection", "exitCode", "health", "image", "imageId", "name", "oomKilled", "restartCount", "state"}
IMAGE_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
OBSERVED_AT_SUFFIX = re.compile(r"(Z|[+-]\d\d:\d\d)$")


def validate_runtime_inventory(payload: dict) -> None:
    if set(payload.keys()) != {"containers", "kind", "observedAt", "serverId"}:
        raise RelayError(400, "invalid_payload")
    if payload.get("kind") != "runtime-inventory-v1":
        raise RelayError(400, "invalid_payload")
    expected = RUNTIME_CONTAINERS.get(payload.get("serverId"))
    if expected is None:
        raise RelayError(400, "invalid_payload")
    observed_at = payload.get("observedAt")
    if not isinstance(observed_at, str) or not OBSERVED_AT_SUFFIX.search(observed_at):
        raise RelayError(400, "invalid_payload")
    observed_ms = parse_timestamp_ms(observed_at)
    now_ms = time.time() * 1000
    if observed_ms is None or observed_ms < now_ms - 300_000 or observed_ms > now_ms + 30_000:
        raise RelayError(400, "invalid_payload")
    containers = payload.get("containers")
    if not isinstance(containers, list) or len(containers) != len(expected):
        raise RelayError(400, "invalid_payload")
    seen = set()
    for row in containers:
        if not isinstance(row, dict) or not isinstance(row.get("name"), str) or row["name"] not in expected or row["name"] in seen:
            raise RelayError(400, "invalid_payload")
        seen.add(row["name"])
        if row.get("collection") == "unavailable":
            if set(row.keys()) != {"collection", "name"}:
                raise RelayError(400, "invalid_payload")
        elif row.get("collection") == "ok":
            if set(row.keys()) != RUNTIME_OK_KEYS:
                raise RelayError(400, "invalid_payload")
            restart_count = row.get("restartCount")
            exit_code = row.get("exitCode")
            if (
                row.get("state") not in RUNTIME_STATES
                or row.get("health") not in RUNTIME_HEALTHS
                or not isinstance(row.get("oomKilled"), bool)
                or isinstance(restart_count, bool)
                or not isinstance(restart_count, int)
                or not 0 <= restart_count <= 2147483647
                or isinstance(exit_code, bool)
                or not isinstance(exit_code, int)
                or not 0 <= exit_code <= 255
                or not isinstance(row.get("image"), str)
                or not IMAGE_PATTERN.match(row["image"])
                or not isinstance(row.get("imageId"), str)
                or not IMAGE_ID_PATTERN.match(row["imageId"])
            ):
                raise RelayError(400, "invalid_payload")
        else:
            raise RelayError(400, "invalid_payload")


def build_rpc_params(path: str, payload: dict, nonce: str, body_sha256: str) -> dict:
    if path == "/api/agent/heartbeat":
        host = payload.get("host")
        if not isinstance(host, dict) or any(
            not isinstance(host.get(field), (int, float)) or isinstance(host.get(field), bool)
            for field in HEARTBEAT_HOST_PARAMS
        ):
            raise RelayError(400, "invalid_payload")
        if not isinstance(payload.get("agentVersion"), str) or not isinstance(payload.get("sentAt"), str):
            raise RelayError(400, "invalid_payload")
        if not isinstance(payload.get("containers"), list):
            raise RelayError(400, "invalid_payload")
        if payload.get("minecraft") is not None and not isinstance(payload.get("minecraft"), dict):
            raise RelayError(400, "invalid_payload")
        params = {
            "p_server_id": payload["serverId"],
            "p_agent_version": payload["agentVersion"],
            "p_sent_at": payload["sentAt"],
            "p_request_nonce": nonce,
            "p_body_sha256": body_sha256,
            "p_containers": payload["containers"],
            "p_minecraft": payload.get("minecraft"),
        }
        for field, param_name in HEARTBEAT_HOST_PARAMS.items():
            params[param_name] = host[field]
        return params
    if path == "/api/agent/cloud":
        if payload.get("kind") != "cloud-monitor-v1":
            raise RelayError(400, "invalid_payload")
        if not isinstance(payload.get("observedAt"), str) or not isinstance(payload.get("results"), list):
            raise RelayError(400, "invalid_payload")
        return {
            "p_server_id": payload["serverId"],
            "p_nonce": nonce,
            "p_body_sha256": body_sha256,
            "p_observed_at": payload["observedAt"],
            "p_results": payload["results"],
        }
    if path == "/api/agent/backups":
        return {
            "p_server_id": payload["serverId"],
            "p_reported_at": payload["reportedAt"],
            "p_request_nonce": nonce,
            "p_body_sha256": body_sha256,
            "p_runs": normalize_backup_runs(payload),
        }
    if path == "/api/agent/logs":
        return {
            "p_server_id": payload["serverId"],
            "p_reported_at": payload["reportedAt"],
            "p_request_nonce": nonce,
            "p_body_sha256": body_sha256,
            "p_entries": normalize_log_entries(payload),
        }
    if path == "/api/agent/runtime":
        validate_runtime_inventory(payload)
        return {
            "p_server_id": payload["serverId"],
            "p_observed_at": payload["observedAt"],
            "p_nonce": nonce,
            "p_containers": payload["containers"],
        }
    raise RelayError(404, "not_found")


def call_rpc(config: Config, rpc_name: str, params: dict, storage_error: str) -> str:
    request = urllib.request.Request(
        f"{config.postgrest_url}/rpc/{rpc_name}",
        data=json.dumps(params).encode("utf-8"),
        method="POST",
        headers={
            "apikey": config.service_key,
            "Authorization": f"Bearer {config.service_key}",
            "Content-Type": "application/json",
            # Cloudflare が Python 既定の User-Agent を遮断する (error 1010) ため明示する
            "User-Agent": "ivrm-ingest-relay/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, ValueError, OSError) as error:
        raise RelayError(503, storage_error) from error
    if not isinstance(result, str):
        raise RelayError(503, storage_error)
    return result


def handle_ingest(config: Config, path: str, headers, raw_body: bytes) -> tuple[int, dict]:
    route = ROUTES[path]
    if len(raw_body) > route["max_bytes"]:
        raise RelayError(413, "payload_too_large")
    if len(raw_body) == 0:
        raise RelayError(400, "empty_payload")
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise RelayError(400, "invalid_payload") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("serverId"), str):
        raise RelayError(400, "invalid_payload")

    nonce, body_sha256 = authenticate(headers, raw_body, payload["serverId"], config.secrets)
    params = build_rpc_params(path, payload, nonce, body_sha256)
    result = call_rpc(config, route["rpc"], params, route["storage_error"])
    if result == "accepted":
        body: dict = {"accepted": True}
        if path in ("/api/agent/heartbeat", "/api/agent/backups"):
            body["receivedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if path == "/api/agent/backups":
            body["runs"] = len(payload["runs"])
        return 202, body
    status = PERSIST_RESULT_STATUS.get(result)
    if status is None:
        raise RelayError(503, route["storage_error"])
    raise RelayError(status, result)


class RelayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    config: Config

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - 標準の署名に合わせる
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))

    def _send_json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"accepted": False, "error": "not_found"})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path not in ROUTES:
            self._send_json(404, {"accepted": False, "error": "not_found"})
            return
        content_type = (self.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            self._send_json(415, {"accepted": False, "error": "unsupported_media_type"})
            return
        route = ROUTES[path]
        declared = self.headers.get("content-length")
        if declared is not None and declared.isdigit() and int(declared) > route["max_bytes"]:
            self._send_json(413, {"accepted": False, "error": "payload_too_large"})
            return
        raw_body = self.rfile.read(int(declared)) if declared and declared.isdigit() else b""
        try:
            status, body = handle_ingest(self.config, path, self.headers, raw_body)
            self._send_json(status, body)
        except RelayError as error:
            self._send_json(error.status, {"accepted": False, "error": error.code})
        except Exception:  # noqa: BLE001 - 予期しないエラーは 500 で返す
            import traceback

            traceback.print_exc()
            self._send_json(500, {"accepted": False, "error": "internal_error"})


def main() -> int:
    try:
        config = Config()
    except (ValueError, OSError) as error:
        print(f"ingest-relay: 設定エラー: {error}", file=sys.stderr)
        return 2
    host, _, port = config.bind.rpartition(":")
    server = ThreadingHTTPServer((host, int(port)), RelayHandler)
    RelayHandler.config = config
    print(f"ingest-relay: listening on {config.bind}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
