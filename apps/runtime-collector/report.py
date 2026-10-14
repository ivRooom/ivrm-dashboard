"""Unprivileged sender: reads a projected snapshot, never the Docker socket."""
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.request

ENDPOINT = "https://console.ivrm.jp/api/agent/runtime"
SNAPSHOT = Path("/run/ivrm-agent/runtime-inventory.json")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("redirect_denied")


def make_request(raw, server_id, token, now=None, nonce=None):
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
    return urllib.request.Request(ENDPOINT, data=raw, headers={
        "Content-Type": "application/json", "User-Agent": "ivrm-agent/runtime-inventory-v1",
        "X-IVRM-Agent-ID": server_id, "X-IVRM-Timestamp": str(timestamp),
        "X-IVRM-Nonce": nonce, "X-IVRM-Signature": signature,
    }, method="POST")


def main():
    with SNAPSHOT.open("rb") as stream:
        raw = stream.read(32769)
    req = make_request(raw, os.environ["IVRM_AGENT_SERVER_ID"], os.environ["IVRM_AGENT_TOKEN"])
    with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
        result = response.read(2049)
        if response.status != 202 or len(result) > 2048 or json.loads(result).get("accepted") is not True:
            raise ValueError("report_rejected")
    print("runtime_inventory_accepted")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("runtime_inventory_failed", file=sys.stderr)
        sys.exit(1)
