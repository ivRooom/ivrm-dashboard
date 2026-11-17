#!/usr/bin/env python3
"""IVRM Dashboard 予備 ingest 受信サービス (ingest-relay).

Console (Vercel) が停止しても監視 ingest が止まらないよう、DB ホスト上で
tailnet 限定で待ち受ける予備の受け口。認証 (HMAC) と DB 書込み (PostgREST RPC)
は本系の Web 実装 (apps/web/lib/operation-agent-auth-core.ts ほか) と同一仕様で、
永続化は同じ DB 関数 (insert_agent_heartbeat_v3 / ingest_cloud_monitor_v1 /
ingest_backup_report_v1 / ingest_console_log_report_v1) に委ねる。

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
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
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
}

PERSIST_RESULT_STATUS = {
    "unknown_agent": 401,
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
        if not isinstance(payload.get("reportedAt"), str) or not isinstance(payload.get("runs"), list):
            raise RelayError(400, "invalid_payload")
        return {
            "p_server_id": payload["serverId"],
            "p_reported_at": payload["reportedAt"],
            "p_request_nonce": nonce,
            "p_body_sha256": body_sha256,
            "p_runs": payload["runs"],
        }
    if path == "/api/agent/logs":
        if not isinstance(payload.get("reportedAt"), str) or not isinstance(payload.get("entries"), list):
            raise RelayError(400, "invalid_payload")
        return {
            "p_server_id": payload["serverId"],
            "p_reported_at": payload["reportedAt"],
            "p_request_nonce": nonce,
            "p_body_sha256": body_sha256,
            "p_entries": payload["entries"],
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
