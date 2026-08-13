import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

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

    def test_send_report_requires_https(self):
        with self.assertRaises(ValueError):
            REPORTER.send_report(
                "http://example.com/api/agent/backups",
                "oci-minecraft-01",
                "x" * 32,
                b"{}",
            )


if __name__ == "__main__":
    unittest.main()
