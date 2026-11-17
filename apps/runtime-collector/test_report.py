import hashlib
import hmac
import json
import os
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

import report
from report import make_request, validate_endpoint, ENDPOINT


class ReportTests(unittest.TestCase):
    def test_signature_covers_exact_payload_and_fixed_destination(self):
        raw = json.dumps({"kind": "runtime-inventory-v1", "serverId": "aws-app-01", "observedAt": "2026-10-15T00:00:00Z", "containers": []}).encode()
        now = 1792022400
        req = make_request(raw, "aws-app-01", "t"*32, now=now, nonce="a"*32)
        self.assertEqual(req.full_url, ENDPOINT)
        self.assertEqual(req.get_method(), "POST")
        expected = hmac.new(b"t"*32, (str(now)+"."+"a"*32+".").encode()+raw, hashlib.sha256).hexdigest()
        self.assertEqual(req.get_header("X-ivrm-signature"), expected)
        self.assertNotIn("t"*32, str(req.headers))

    def test_stale_snapshot_cross_host_and_oversized_body_are_rejected(self):
        raw = json.dumps({"kind": "runtime-inventory-v1", "serverId": "aws-app-01", "observedAt": "2026-10-15T00:00:00Z", "containers": []}).encode()
        for content, server, now in ((raw,"other",1792022400),(raw,"aws-app-01",1792022521),(b"x"*32769,"aws-app-01",1792022400)):
            with self.assertRaises(ValueError):
                make_request(content, server, "t"*32, now=now)

    def test_fallback_endpoint_validation(self):
        validate_endpoint("https://console.ivrm.jp/api/agent/runtime")
        validate_endpoint("http://100.117.170.101:3939/api/agent/runtime")
        validate_endpoint("http://localhost:3939/api/agent/runtime")
        validate_endpoint("http://db.example.ts.net:3939/api/agent/runtime")
        for bad in ("http://example.com:3939/api/agent/runtime", "http://192.168.1.10:3939/api/agent/runtime", "ftp://100.117.170.101/x"):
            with self.assertRaises(ValueError):
                validate_endpoint(bad)

    def test_make_request_honors_endpoint_override(self):
        raw = json.dumps({"kind": "runtime-inventory-v1", "serverId": "aws-app-01", "observedAt": "2026-10-15T00:00:00Z", "containers": []}).encode()
        req = make_request(raw, "aws-app-01", "t"*32, now=1792022400, nonce="b"*32, endpoint="http://100.117.170.101:3939/api/agent/runtime")
        self.assertEqual(req.full_url, "http://100.117.170.101:3939/api/agent/runtime")

    def test_main_falls_back_when_primary_fails(self):
        observed = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        snapshot = json.dumps({"kind": "runtime-inventory-v1", "serverId": "aws-app-01", "observedAt": observed, "containers": []}).encode()
        fallback = "http://100.117.170.101:3939/api/agent/runtime"
        calls = []
        def fake_send(raw, server_id, token, endpoint):
            calls.append(endpoint)
            if endpoint == ENDPOINT:
                raise urllib.error.URLError("primary down")
        with tempfile.TemporaryDirectory() as tmp:
            snapshot_path = Path(tmp) / "runtime-inventory.json"
            snapshot_path.write_bytes(snapshot)
            env = {"IVRM_AGENT_SERVER_ID": "aws-app-01", "IVRM_AGENT_TOKEN": "t"*32, report.FALLBACK_ENV: fallback}
            with mock.patch.object(report, "SNAPSHOT", snapshot_path), mock.patch.dict(os.environ, env), mock.patch.object(report, "send_once", fake_send):
                report.main()
        self.assertEqual(calls, [ENDPOINT, fallback])
