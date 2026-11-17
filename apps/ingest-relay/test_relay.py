#!/usr/bin/env python3
"""ingest-relay の契約テスト (DB には触れず、RPC 呼び出しをモックする)。"""

import hashlib
import hmac
import json
import time
import unittest
from unittest import mock

import relay

SECRET = "s" * 40
SERVER_ID = "aws-app-01"


class FakeHeaders(dict):
    def get(self, key, default=None):
        return super().get(key.lower(), default)


def signed_headers(body: bytes, secret: str = SECRET, server_id: str = SERVER_ID, timestamp: int | None = None):
    ts = str(int(time.time()) if timestamp is None else timestamp)
    nonce = "a" * 32
    signature = hmac.new(secret.encode(), ts.encode() + b"." + nonce.encode() + b"." + body, hashlib.sha256).hexdigest()
    return FakeHeaders(
        {
            "x-ivrm-agent-id": server_id,
            "x-ivrm-timestamp": ts,
            "x-ivrm-nonce": nonce,
            "x-ivrm-signature": signature,
        }
    )


def heartbeat_body() -> bytes:
    return json.dumps(
        {
            "serverId": SERVER_ID,
            "agentVersion": "1.2.3",
            "sentAt": "2026-11-18T00:00:00Z",
            "host": {
                "cpuCount": 2,
                "memoryTotalBytes": 100,
                "memoryAvailableBytes": 50,
                "diskTotalBytes": 200,
                "diskAvailableBytes": 80,
                "loadAverage1": 0.1,
                "loadAverage5": 0.2,
                "loadAverage15": 0.3,
                "uptimeSeconds": 1234,
            },
            "containers": [],
            "minecraft": None,
        }
    ).encode()


class RelayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = mock.Mock()
        self.config.secrets = {SERVER_ID: SECRET}
        self.config.postgrest_url = "http://postgrest.invalid/rest/v1"
        self.config.service_key = "service-key"

    def call(self, path: str, body: bytes, headers=None):
        with mock.patch.object(relay, "call_rpc", return_value="accepted") as rpc:
            status, response = relay.handle_ingest(self.config, path, headers or signed_headers(body), body)
            return status, response, rpc

    def test_heartbeat_accepted_and_params(self):
        status, response, rpc = self.call("/api/agent/heartbeat", heartbeat_body())
        self.assertEqual(status, 202)
        self.assertTrue(response["accepted"])
        rpc_name = rpc.call_args.args[1]
        params = rpc.call_args.args[2]
        self.assertEqual(rpc_name, "insert_agent_heartbeat_v3")
        self.assertEqual(params["p_server_id"], SERVER_ID)
        self.assertEqual(params["p_cpu_count"], 2)
        self.assertEqual(params["p_load_average_1"], 0.1)
        self.assertEqual(params["p_load_average_15"], 0.3)
        self.assertEqual(params["p_request_nonce"], "a" * 32)
        self.assertEqual(params["p_body_sha256"], hashlib.sha256(heartbeat_body()).hexdigest())

    def test_heartbeat_without_minecraft_key_accepted(self):
        # Go agent は minecraft プローブが無いホストではキー自体を省略する (omitempty)。
        payload = json.loads(heartbeat_body())
        del payload["minecraft"]
        body = json.dumps(payload).encode()
        status, _, rpc = self.call("/api/agent/heartbeat", body)
        self.assertEqual(status, 202)
        self.assertIsNone(rpc.call_args.args[2]["p_minecraft"])

    def test_cloud_accepted(self):
        body = json.dumps(
            {"kind": "cloud-monitor-v1", "serverId": SERVER_ID, "observedAt": "2026-11-18T00:00:00Z", "results": []}
        ).encode()
        status, _, rpc = self.call("/api/agent/cloud", body)
        self.assertEqual(status, 202)
        self.assertEqual(rpc.call_args.args[1], "ingest_cloud_monitor_v1")

    def test_cloud_wrong_kind_rejected(self):
        body = json.dumps({"kind": "other", "serverId": SERVER_ID, "observedAt": "x", "results": []}).encode()
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/cloud", body)
        self.assertEqual(ctx.exception.status, 400)

    def test_backups_and_logs_accepted(self):
        backups = json.dumps({"serverId": SERVER_ID, "reportedAt": "2026-11-18T00:00:00Z", "runs": []}).encode()
        status, response, rpc = self.call("/api/agent/backups", backups)
        self.assertEqual(status, 202)
        self.assertEqual(response["runs"], 0)
        self.assertEqual(rpc.call_args.args[1], "ingest_backup_report_v1")

        logs = json.dumps({"serverId": SERVER_ID, "reportedAt": "2026-11-18T00:00:00Z", "entries": []}).encode()
        status, _, rpc = self.call("/api/agent/logs", logs)
        self.assertEqual(status, 202)
        self.assertEqual(rpc.call_args.args[1], "ingest_console_log_report_v1")

    def test_bad_signature_rejected(self):
        body = heartbeat_body()
        headers = signed_headers(body, secret="x" * 40)
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/heartbeat", body, headers)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (401, "invalid_signature"))

    def test_agent_id_mismatch_rejected(self):
        body = heartbeat_body()
        headers = signed_headers(body, server_id="other-host")
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/heartbeat", body, headers)
        self.assertEqual(ctx.exception.code, "agent_id_mismatch")

    def test_expired_timestamp_rejected(self):
        body = heartbeat_body()
        headers = signed_headers(body, timestamp=int(time.time()) - 3600)
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/heartbeat", body, headers)
        self.assertEqual(ctx.exception.code, "expired_request")

    def test_unknown_agent_rejected(self):
        body = json.dumps({"serverId": "ghost", "reportedAt": "x", "runs": []}).encode()
        headers = signed_headers(body, server_id="ghost")
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/backups", body, headers)
        self.assertEqual(ctx.exception.code, "unknown_agent")

    def test_replay_and_rate_limit_mapping(self):
        body = heartbeat_body()
        for result, expected_status in (("replayed_request", 409), ("rate_limited", 429), ("invalid_payload", 400)):
            with mock.patch.object(relay, "call_rpc", return_value=result):
                with self.assertRaises(relay.RelayError) as ctx:
                    relay.handle_ingest(self.config, "/api/agent/heartbeat", signed_headers(body), body)
            self.assertEqual(ctx.exception.status, expected_status)

    def test_oversize_and_empty_rejected(self):
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/cloud", b"x" * (16 * 1024 + 1))
        self.assertEqual(ctx.exception.status, 413)
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/cloud", b"")
        self.assertEqual(ctx.exception.status, 400)

    def test_rpc_request_has_explicit_user_agent(self):
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'"accepted"'

        def fake_urlopen(request, timeout=None):
            captured["user_agent"] = request.get_header("User-agent")
            return FakeResponse()

        with mock.patch.object(relay.urllib.request, "urlopen", fake_urlopen):
            result = relay.call_rpc(self.config, "insert_agent_heartbeat_v3", {}, "storage_unavailable")
        self.assertEqual(result, "accepted")
        self.assertEqual(captured["user_agent"], "ivrm-ingest-relay/1.0")

    def test_heartbeat_missing_host_field_rejected(self):
        payload = json.loads(heartbeat_body())
        del payload["host"]["cpuCount"]
        body = json.dumps(payload).encode()
        with self.assertRaises(relay.RelayError) as ctx:
            self.call("/api/agent/heartbeat", body)
        self.assertEqual(ctx.exception.code, "invalid_payload")


if __name__ == "__main__":
    unittest.main()
