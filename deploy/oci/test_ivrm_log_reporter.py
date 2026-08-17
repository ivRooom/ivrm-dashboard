import importlib.util
import json
import pathlib
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("ivrm-log-reporter.py")
loader = SourceFileLoader("ivrm_log_reporter", str(MODULE_PATH))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class LogReporterTests(unittest.TestCase):
    def test_normalize_java_nanosecond_timestamp(self):
        self.assertEqual(
            module.normalize_rfc3339("2026-08-17T13:46:51.450052301Z"),
            "2026-08-17T13:46:51.450052Z",
        )

    def test_redacts_secrets_ip_and_ansi(self):
        value = module.redact_message(
            "\x1b[31mERROR\x1b[0m token=abc123456789 password hunter2 from 119.173.40.88 Bearer abcdefghijklmnop"
        )
        self.assertNotIn("abc123456789", value)
        self.assertNotIn("hunter2", value)
        self.assertNotIn("119.173.40.88", value)
        self.assertNotIn("abcdefghijklmnop", value)
        self.assertNotIn("\x1b", value)
        self.assertIn("[REDACTED]", value)
        self.assertIn("[REDACTED_IP]", value)

    def test_classify_level(self):
        self.assertEqual(module.classify_level("[Server thread/ERROR] failed"), "error")
        self.assertEqual(module.classify_level("[WARN] slow"), "warning")
        self.assertEqual(module.classify_level("ready"), "info")

    def test_encode_body_is_bounded(self):
        entries = [
            {
                "sourceType": "container",
                "sourceName": "mc-main",
                "observedAt": "2026-08-18T00:00:00.000000Z",
                "level": "info",
                "message": "x" * module.MAX_LINE_CHARACTERS,
            }
            for _ in range(module.MAX_ENTRIES)
        ]
        body = module.encode_body("oci-minecraft-01", entries, "2026-08-18T00:00:01.000000Z")
        parsed = json.loads(body)
        self.assertLessEqual(len(body), module.MAX_REPORT_BODY_BYTES)
        self.assertGreater(len(parsed["entries"]), 0)
        self.assertLessEqual(len(parsed["entries"]), module.MAX_ENTRIES)

    def test_disabled_does_not_collect(self):
        with mock.patch.dict(module.os.environ, {"IVRM_LOG_REPORTING_ENABLED": "false"}, clear=False), mock.patch.object(
            module, "collect_entries"
        ) as collect:
            self.assertEqual(module.main(), 0)
            collect.assert_not_called()

    def test_docker_collection_uses_fixed_argv(self):
        completed = mock.Mock(
            returncode=0,
            stdout="2026-08-17T13:46:51.450052301Z [INFO] Done\n",
        )
        with mock.patch.object(module.subprocess, "run", return_value=completed) as run:
            entries = module.docker_log_entries("mc-main", 20)
        argv = run.call_args.args[0]
        self.assertEqual(argv[0], "/usr/bin/docker")
        self.assertEqual(argv[-1], "mc-main")
        self.assertEqual(entries[0]["sourceName"], "mc-main")
        self.assertEqual(entries[0]["observedAt"], "2026-08-17T13:46:51.450052Z")

    def test_validate_endpoint_rejects_plain_http_remote(self):
        with self.assertRaises(ValueError):
            module.validate_endpoint("http://example.com/api/agent/logs")
        module.validate_endpoint("https://console.ivrm.jp/api/agent/logs")
        module.validate_endpoint("http://127.0.0.1:3000/api/agent/logs")


if __name__ == "__main__":
    unittest.main()
