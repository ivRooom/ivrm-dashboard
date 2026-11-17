import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("ivrm-backup-reporter.py")
SPEC = importlib.util.spec_from_file_location("ivrm_backup_reporter", MODULE_PATH)
assert SPEC and SPEC.loader
REPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORTER)


class BackupReporterTests(unittest.TestCase):
    def test_sign_is_stable(self):
        actual = REPORTER.sign(b"secret", "123", "nonce-123", b'{"ok":true}')
        self.assertEqual(
            actual,
            "439929cf1bf76a205925a0c96707e55815bb299491005de149afc9cb41fc7cd2",
        )

    def test_build_body_adds_server_and_reported_at(self):
        body = REPORTER.build_body(
            "oci-minecraft-01",
            {"runs": [{"runId": "123"}]},
            "2026-08-13T06:00:00Z",
        )
        payload = json.loads(body)
        self.assertEqual(payload["serverId"], "oci-minecraft-01")
        self.assertEqual(payload["reportedAt"], "2026-08-13T06:00:00Z")
        self.assertEqual(payload["runs"], [{"runId": "123"}])

    def test_load_input_rejects_sensitive_extra_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(
                json.dumps({"runs": [{"runId": "123"}], "stdout": "secret-ish log"}),
                encoding="utf-8",
            )
            with self.assertRaises(ValueError):
                REPORTER.load_input(path)

    def test_load_input_rejects_empty_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "report.json"
            path.write_text(json.dumps({"runs": []}), encoding="utf-8")
            with self.assertRaises(ValueError):
                REPORTER.load_input(path)

    def test_validate_endpoint_requires_https_for_remote_hosts(self):
        with self.assertRaises(ValueError):
            REPORTER.validate_endpoint("http://example.com/api/agent/backups")

    def test_validate_endpoint_rejects_localhost_prefix_attack(self):
        for endpoint in (
            "http://localhost.evil.example/api/agent/backups",
            "http://127.0.0.1.evil.example/api/agent/backups",
            "http://localhost@evil.example/api/agent/backups",
        ):
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                REPORTER.validate_endpoint(endpoint)

    def test_validate_endpoint_allows_only_exact_loopback_http(self):
        for endpoint in (
            "http://localhost:3000/api/agent/backups",
            "http://127.0.0.1:3000/api/agent/backups",
            "http://[::1]:3000/api/agent/backups",
        ):
            with self.subTest(endpoint=endpoint):
                REPORTER.validate_endpoint(endpoint)

    def test_validate_endpoint_allows_https(self):
        REPORTER.validate_endpoint("https://console.ivrm.jp/api/agent/backups")

    def test_validate_endpoint_allows_tailnet_http(self):
        for endpoint in (
            "http://ivrm-db-postgres-01.tailnet.example.ts.net:3939/api/agent/backups",
            "http://100.117.170.101:3939/api/agent/backups",
        ):
            with self.subTest(endpoint=endpoint):
                REPORTER.validate_endpoint(endpoint)

    def test_validate_endpoint_rejects_ts_net_lookalike(self):
        with self.assertRaises(ValueError):
            REPORTER.validate_endpoint("http://evilts.net.example.com/api/agent/backups")
        with self.assertRaises(ValueError):
            REPORTER.validate_endpoint("http://100.200.1.1:3939/api/agent/backups")

    def test_deliver_falls_back_on_error_status_and_exception(self):
        body = b"{}"
        with mock.patch.object(REPORTER, "send_report", side_effect=[402, 202]) as send:
            self.assertEqual(REPORTER.deliver(["https://a", "http://b"], "srv", "x" * 32, body), 202)
            self.assertEqual(send.call_count, 2)
        with mock.patch.object(REPORTER, "send_report", side_effect=[REPORTER.urllib.error.URLError("down"), 202]):
            self.assertEqual(REPORTER.deliver(["https://a", "http://b"], "srv", "x" * 32, body), 202)
        with mock.patch.object(REPORTER, "send_report", side_effect=[202, 202]) as send:
            self.assertEqual(REPORTER.deliver(["https://a", "http://b"], "srv", "x" * 32, body), 202)
            self.assertEqual(send.call_count, 1)


if __name__ == "__main__":
    unittest.main()
