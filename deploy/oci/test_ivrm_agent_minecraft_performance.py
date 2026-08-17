from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("ivrm-agent-minecraft-performance.py")
SPEC = importlib.util.spec_from_file_location("ivrm_agent_minecraft_performance", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Performance Collectorモジュールを読み込めません")

collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)

NOW = datetime(2026, 8, 17, 12, 30, 0, tzinfo=timezone.utc)


def bridge_document(**overrides: object) -> dict[str, object]:
    document: dict[str, object] = {
        "generatedAt": "2026-08-17T12:29:50Z",
        "source": "spark",
        "tps1m": 19.98,
        "tps5m": 19.95,
        "tps15m": 19.90,
        "msptMedian1m": 3.4,
        "msptP95_1m": 9.8,
        "msptMax1m": 41.2,
    }
    document.update(overrides)
    return document


class BridgeMetricsParserTest(unittest.TestCase):
    def test_parses_fresh_structured_metrics(self) -> None:
        result = collector.parse_bridge_metrics(json.dumps(bridge_document()), now=NOW)
        self.assertEqual(
            result,
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

    def test_rejects_stale_metrics(self) -> None:
        generated_at = NOW - timedelta(seconds=46)
        with self.assertRaisesRegex(RuntimeError, "古すぎ"):
            collector.parse_bridge_metrics(
                json.dumps(bridge_document(generatedAt=generated_at.isoformat())),
                now=NOW,
            )

    def test_rejects_metrics_too_far_in_future(self) -> None:
        generated_at = NOW + timedelta(seconds=6)
        with self.assertRaisesRegex(RuntimeError, "未来"):
            collector.parse_bridge_metrics(
                json.dumps(bridge_document(generatedAt=generated_at.isoformat())),
                now=NOW,
            )

    def test_rejects_extra_keys(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "key"):
            collector.parse_bridge_metrics(
                json.dumps(bridge_document(unexpected="do-not-forward")),
                now=NOW,
            )

    def test_rejects_boolean_metric(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "数値形式"):
            collector.parse_bridge_metrics(
                json.dumps(bridge_document(tps1m=True)),
                now=NOW,
            )

    def test_rejects_invalid_mspt_order(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "順序"):
            collector.parse_bridge_metrics(
                json.dumps(
                    bridge_document(
                        msptMedian1m=10.0,
                        msptP95_1m=8.0,
                        msptMax1m=20.0,
                    )
                ),
                now=NOW,
            )

    def test_rejects_wrong_source(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "source"):
            collector.parse_bridge_metrics(
                json.dumps(bridge_document(source="unknown")),
                now=NOW,
            )


class BridgeCommandTest(unittest.TestCase):
    def test_reads_fixed_file_from_fixed_container(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(bridge_document()),
            stderr="",
        )
        with mock.patch.object(collector.subprocess, "run", return_value=completed) as run, mock.patch.object(
            collector,
            "parse_bridge_metrics",
            return_value={"source": "spark"},
        ):
            collector.collect_spark_metrics("/usr/bin/docker")

        self.assertEqual(
            run.call_args.args[0],
            [
                "/usr/bin/docker",
                "exec",
                "mc-main",
                "cat",
                "/data/ivrm/metrics.json",
            ],
        )
        self.assertFalse(run.call_args.kwargs["check"])
        self.assertEqual(run.call_args.kwargs["timeout"], 5)

    def test_translates_timeout_without_exposing_file_content(self) -> None:
        with mock.patch.object(
            collector.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["docker", "exec"], 5),
        ):
            with self.assertRaisesRegex(RuntimeError, "取得できません"):
                collector.collect_spark_metrics("/usr/bin/docker")

    def test_rejects_failed_cat(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout="",
            stderr="sensitive diagnostics must not be forwarded",
        )
        with mock.patch.object(collector.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(RuntimeError, "取得できません"):
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
