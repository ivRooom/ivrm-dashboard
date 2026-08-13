#!/usr/bin/env python3
"""IVRM Backup Centerへ構造化Backup Runを署名付きで送信する。"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MAX_INPUT_BYTES = 32 * 1024
ALLOWED_INPUT_KEYS = {"runs"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sign(secret: bytes, timestamp: str, nonce: str, body: bytes) -> str:
    return hmac.new(
        secret,
        timestamp.encode("ascii") + b"." + nonce.encode("ascii") + b"." + body,
        hashlib.sha256,
    ).hexdigest()


def load_input(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    if not data or len(data) > MAX_INPUT_BYTES:
        raise ValueError("入力JSONのサイズが不正です")
    try:
        value = json.loads(data)
    except json.JSONDecodeError as exc:
        raise ValueError("入力JSONが不正です") from exc
    if not isinstance(value, dict) or set(value) - ALLOWED_INPUT_KEYS:
        raise ValueError("入力JSONにはrunsだけを指定してください")
    runs = value.get("runs")
    if not isinstance(runs, list) or not 1 <= len(runs) <= 20:
        raise ValueError("runsは1〜20件の配列にしてください")
    return value


def build_body(server_id: str, input_value: dict[str, Any], reported_at: str | None = None) -> bytes:
    if not server_id or len(server_id) > 64:
        raise ValueError("IVRM_AGENT_SERVER_IDが不正です")
    payload = {
        "serverId": server_id,
        "reportedAt": reported_at or utc_now_iso(),
        "runs": input_value["runs"],
    }
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def send_report(endpoint: str, server_id: str, secret: str, body: bytes) -> int:
    if not endpoint.startswith("https://") and not endpoint.startswith("http://127.0.0.1") and not endpoint.startswith("http://localhost"):
        raise ValueError("Backup EndpointはHTTPSを使用してください")
    if len(secret) < 32:
        raise ValueError("IVRM_AGENT_TOKENは32文字以上が必要です")

    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    signature = sign(secret.encode("utf-8"), timestamp, nonce, body)
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "ivrm-backup-reporter/1.0.0",
            "X-IVRM-Agent-ID": server_id,
            "X-IVRM-Timestamp": timestamp,
            "X-IVRM-Nonce": nonce,
            "X-IVRM-Signature": signature,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="IVRM Backup Centerへ構造化Backup Reportを送信します")
    parser.add_argument("--input", required=True, help="{\"runs\":[...]}形式のJSONファイル")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    server_id = os.environ.get("IVRM_AGENT_SERVER_ID", "").strip()
    endpoint = os.environ.get("IVRM_AGENT_BACKUP_ENDPOINT", "").strip()
    secret = os.environ.get("IVRM_AGENT_TOKEN", "")
    if not server_id or not endpoint or not secret:
        print("IVRM_AGENT_SERVER_ID・IVRM_AGENT_BACKUP_ENDPOINT・IVRM_AGENT_TOKENは必須です", file=sys.stderr)
        return 2

    try:
        input_value = load_input(Path(args.input))
        body = build_body(server_id, input_value)
        status = send_report(endpoint, server_id, secret, body)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(f"Backup Report送信に失敗しました: {exc}", file=sys.stderr)
        return 1

    if 200 <= status < 300:
        print(f"Backup Reportを送信しました: status={status} runs={len(input_value['runs'])}")
        return 0

    print(f"Backup Report APIがエラーを返しました: status={status}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
