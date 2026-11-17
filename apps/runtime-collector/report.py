"""Unprivileged sender: reads a projected snapshot, never the Docker socket."""
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://console.ivrm.jp/api/agent/runtime"
FALLBACK_ENV = "IVRM_AGENT_RUNTIME_FALLBACK_ENDPOINT"
SNAPSHOT = Path("/run/ivrm-agent/runtime-inventory.json")

TAILNET_NETWORK = ipaddress.ip_network("100.64.0.0/10")


def is_tailnet_host(hostname: str) -> bool:
    """Tailscale の宛先 (MagicDNS 名 / CGNAT 帯 IP) は WireGuard で暗号化されるため HTTP を許可する。"""
    if hostname.endswith(".ts.net"):
        return True
    try:
        return ipaddress.ip_address(hostname) in TAILNET_NETWORK
    except ValueError:
        return False


def validate_endpoint(endpoint: str) -> None:
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme == "https":
        return
    if parsed.scheme != "http":
        raise ValueError("Runtime EndpointはHTTPSを使用してください")
    hostname = parsed.hostname or ""
    if hostname == "localhost" or is_tailnet_host(hostname):
        return
    try:
        if ipaddress.ip_address(hostname).is_loopback:
            return
    except ValueError:
        pass
    raise ValueError("HTTPはlocalhostまたはtailnet宛先でのみ使用できます")


def fallback_endpoint() -> str | None:
    endpoint = os.environ.get(FALLBACK_ENV, "").strip()
    if not endpoint:
        return None
    validate_endpoint(endpoint)
    return endpoint


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect_denied")


def make_request(raw, server_id, token, now=None, nonce=None, endpoint=ENDPOINT):
    if len(raw) > 32768 or len(token) < 32:
        raise ValueError("invalid_configuration")
    payload = json.loads(raw)
    if payload.get("kind") != "runtime-inventory-v1" or payload.get("serverId") != server_id:
        raise ValueError("invalid_snapshot")
    observed = dt.datetime.fromisoformat(payload["observedAt"].replace("Z", "+00:00"))
    if observed.tzinfo is None:
        raise ValueError("invalid_snapshot")
    timestamp = int(time.time()) if now is None else now
    if not -30 <= timestamp-observed.timestamp() <= 120:
        raise ValueError("stale_snapshot")
    nonce = secrets.token_hex(16) if nonce is None else nonce
    prefix = str(timestamp) + "." + nonce + "."
    signature = hmac.new(token.encode(), prefix.encode()+raw, hashlib.sha256).hexdigest()
    return urllib.request.Request(endpoint, data=raw, headers={
        "Content-Type": "application/json", "User-Agent": "ivrm-agent/runtime-inventory-v1",
        "X-IVRM-Agent-ID": server_id, "X-IVRM-Timestamp": str(timestamp),
        "X-IVRM-Nonce": nonce, "X-IVRM-Signature": signature,
    }, method="POST")


def send_once(raw, server_id, token, endpoint):
    validate_endpoint(endpoint)
    req = make_request(raw, server_id, token, endpoint=endpoint)
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
        result = response.read(2049)
        if response.status != 202 or len(result) > 2048 or json.loads(result).get("accepted") is not True:
            raise ValueError("report_rejected")


def main():
    with SNAPSHOT.open("rb") as stream:
        raw = stream.read(32769)
    server_id = os.environ["IVRM_AGENT_SERVER_ID"]
    token = os.environ["IVRM_AGENT_TOKEN"]
    endpoints = [ENDPOINT]
    fallback = fallback_endpoint()
    if fallback:
        endpoints.append(fallback)
    last_error: Exception | None = None
    for endpoint in endpoints:
        try:
            send_once(raw, server_id, token, endpoint)
        except Exception as error:  # 主系の失敗時は予備へ切り替える
            last_error = error
            continue
        print("runtime_inventory_accepted")
        return
    assert last_error is not None
    raise last_error


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("runtime_inventory_failed", file=sys.stderr)
        sys.exit(1)
