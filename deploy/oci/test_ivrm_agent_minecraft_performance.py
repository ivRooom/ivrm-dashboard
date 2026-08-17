from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("ivrm-agent-minecraft-performance.py")
SPEC = importlib.util.spec_from_file_location("ivrm_agent_minecraft_performance", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Performance Collectorモジュールを読み込めません")

collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class SparkOutputParserTest(unittest.TestCase):
    def test_parses_tps_and_one_minute_mspt(self) -> None:
        output = """[⚡] TPS from last 5s, 10s, 1m, 5m, 15m:
[⚡] *20.0, *20.0, 19.98, 19.95, 19.90
[⚡]
[⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:
[⚡] 2.1/3.0/8.0/20.0; 2.2/3.4/9.8/41.2
"""
        self.assertEqual(
            collector.parse_spark_tps_output(output),
            {
                "source": "spark",
                "tps1m": 19.98,
                "tps5m": 19.95,
                "tps15m": 19.9,
                "msptMedian1m": 3.4,
                "msptP95_1m": 9.8,
                "msptMax1m": 41.2,
            },
        )

    def test_ignores_minecraft_and_ansi_format_codes(self) -> None:
        output = (
            "§6[⚡] TPS from last 5s, 10s, 1m, 5m, 15m:§r\n"
            "\x1b[32m[⚡] *20.0, *20.0, *20.0, 20.0, 20.0\x1b[0m\n"
            "[⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:\n"
            "[⚡] 1/2/3/4; 1.5/2.5/3.5/4.5\n"
        )
        result = collector.parse_spark_tps_output(output)
        self.assertEqual(result["tps1m"], 20.0)
        self.assertEqual(result["msptP95_1m"], 3.5)

    def test_rejects_missing_mspt(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "認識"):
            collector.parse_spark_tps_output(
                "TPS from last 5s, 10s, 1m, 5m, 15m:\n20,20,20,20,20\n"
            )

    def test_rejects_invalid_mspt_order(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "順序"):
            collector.parse_spark_tps_output(
                "TPS from last 5s, 10s, 1m, 5m, 15m:\n"
                "20,20,20,20,20\n"
                "Tick durations (min/med/95%ile/max ms) from last 10s, 1m:\n"
                "1/2/3/4; 1/8/7/9\n"
            )


class SparkCommandTest(unittest.TestCase):
    def test_executes_fixed_container_and_command(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=(
                "TPS from last 5s, 10s, 1m, 5m, 15m:\n"
                "20,20,20,20,20\n"
                "Tick durations (min/med/95%ile/max ms) from last 10s, 1m:\n"
                "1/2/3/4; 1/2/3/4\n"
            ),
            stderr="",
        )
        with mock.patch.object(collector.subprocess, "run", return_value=completed) as run:
            collector.collect_spark_metrics("/usr/bin/docker")

        self.assertEqual(
            run.call_args.args[0],
            ["/usr/bin/docker", "exec", "mc-main", "rcon-cli", "spark", "tps"],
        )
        self.assertFalse(run.call_args.kwargs["check"])
        self.assertEqual(run.call_args.kwargs["timeout"], 5)

    def test_translates_timeout_without_exposing_command_output(self) -> None:
        with mock.patch.object(
            collector.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["docker", "exec"], 5),
        ):
            with self.assertRaisesRegex(RuntimeError, "実行できません"):
                collector.collect_spark_metrics("/usr/bin/docker")


class SnapshotAugmentTest(unittest.TestCase):
    def test_augments_existing_minecraft_probe(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docker-state.json"
            path.write_text(
                json.dumps(
                    {
                        "generatedAt": "2026-08-17T10:00:00Z",
                        "containers": [],
                        "minecraft": {
                            "publicEndpoint": {"reachable": False},
                            "backend": {"reachable": False},
                            "proxyPortPublished": False,
                            "backendPortPublished": False,
                            "voiceChatPortPublished": False,
                        },
                    }
                ),
                encoding="utf-8",
            )
            performance = {
                "source": "spark",
                "tps1m": 20.0,
                "tps5m": 20.0,
                "tps15m": 20.0,
                "msptMedian1m": 3.0,
                "msptP95_1m": 6.0,
                "msptMax1m": 12.0,
            }
            with mock.patch.object(collector.grp, "getgrnam") as getgrnam, mock.patch.object(
                collector.os, "chown"
            ):
                getgrnam.return_value.gr_gid = os.getgid()
                self.assertTrue(collector.augment_snapshot(path, performance))

            document = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(document["minecraft"]["performance"], performance)
            self.assertEqual(document["generatedAt"], "2026-08-17T10:00:00Z")

    def test_does_not_create_minecraft_probe_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docker-state.json"
            path.write_text(
                json.dumps({"generatedAt": "2026-08-17T10:00:00Z", "containers": []}),
                encoding="utf-8",
            )
            self.assertFalse(collector.augment_snapshot(path, {"source": "spark"}))


if __name__ == "__main__":
    unittest.main()
