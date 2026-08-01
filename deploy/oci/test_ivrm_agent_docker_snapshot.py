from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("ivrm-agent-docker-snapshot.py")
SPEC = importlib.util.spec_from_file_location("ivrm_agent_docker_snapshot", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Collectorモジュールを読み込めません")

collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class ParseSizeTest(unittest.TestCase):
    def test_parses_binary_unit(self) -> None:
        self.assertEqual(collector.parse_size("1.5GiB"), 1_610_612_736)

    def test_parses_decimal_unit(self) -> None:
        self.assertEqual(collector.parse_size("923kB"), 923_000)

    def test_parses_zero_bytes(self) -> None:
        self.assertEqual(collector.parse_size("0B"), 0)

    def test_rejects_unknown_unit(self) -> None:
        with self.assertRaises(ValueError):
            collector.parse_size("12XB")


class ParseDockerStatsTest(unittest.TestCase):
    def test_parses_size_pair(self) -> None:
        self.assertEqual(
            collector.parse_size_pair("128MiB / 2GiB"),
            (134_217_728, 2_147_483_648),
        )

    def test_parses_cpu_percent(self) -> None:
        self.assertEqual(collector.parse_percent("12.34%"), 12.34)

    def test_parses_pids(self) -> None:
        self.assertEqual(collector.parse_pids("42"), 42)

    def test_rejects_partial_size_pair(self) -> None:
        with self.assertRaises(ValueError):
            collector.parse_size_pair("128MiB")


if __name__ == "__main__":
    unittest.main()
