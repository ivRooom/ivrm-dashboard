from __future__ import annotations

import importlib.util
import os
import subprocess
import unittest
from pathlib import Path
from unittest import mock

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

    def test_translates_stats_timeout_to_runtime_error(self) -> None:
        with mock.patch.object(
            collector.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired(["docker", "stats"], 12),
        ):
            with self.assertRaisesRegex(RuntimeError, "タイムアウト"):
                collector.collect_stats("/usr/bin/docker", "mc-main")


class MinecraftProbeTest(unittest.TestCase):
    def test_encodes_varint(self) -> None:
        self.assertEqual(collector.encode_varint(0), b"\x00")
        self.assertEqual(collector.encode_varint(25565), b"\xdd\xc7\x01")

    def test_parses_status_response(self) -> None:
        self.assertEqual(
            collector.parse_status_response(
                {
                    "version": {"name": "Velocity 1.7.2-26.2"},
                    "players": {"online": 3, "max": 10},
                }
            ),
            ("Velocity 1.7.2-26.2", 3, 10),
        )

    def test_rejects_invalid_player_count(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "許容範囲外"):
            collector.parse_status_response(
                {
                    "version": {"name": "26.1.2"},
                    "players": {"online": 11, "max": 10},
                }
            )

    def test_detects_published_port(self) -> None:
        document = {
            "HostConfig": {
                "PortBindings": {"25565/tcp": [{"HostPort": "25565"}]}
            },
            "NetworkSettings": {"Ports": {}},
        }
        self.assertTrue(collector.is_port_published(document, "25565/tcp"))
        self.assertFalse(collector.is_port_published(document, "24454/udp"))

    def test_reads_private_backend_ip(self) -> None:
        document = {
            "NetworkSettings": {
                "Networks": {
                    "minecraft-main_default": {
                        "IPAddress": "172.30.0.4",
                        "NetworkID": "fixed-network-id",
                    }
                }
            }
        }
        self.assertEqual(collector.backend_ip(document), "172.30.0.4")

    def test_rejects_public_backend_ip(self) -> None:
        document = {
            "NetworkSettings": {
                "Networks": {
                    "minecraft-main_default": {
                        "IPAddress": "8.8.8.8",
                        "NetworkID": "fixed-network-id",
                    }
                }
            }
        }
        self.assertIsNone(collector.backend_ip(document))

    def test_backend_probe_requires_same_network_id(self) -> None:
        proxy = {
            "HostConfig": {"PortBindings": {}},
            "NetworkSettings": {
                "Ports": {},
                "Networks": {
                    "minecraft-main_default": {
                        "IPAddress": "172.30.0.2",
                        "NetworkID": "proxy-network",
                    }
                },
            },
        }
        backend = {
            "HostConfig": {"PortBindings": {}},
            "NetworkSettings": {
                "Ports": {},
                "Networks": {
                    "minecraft-main_default": {
                        "IPAddress": "172.30.0.4",
                        "NetworkID": "backend-network",
                    }
                },
            },
        }
        public_result = {
            "reachable": True,
            "latencyMs": 1,
            "version": "Velocity",
            "online": 0,
            "max": 10,
        }
        with mock.patch.object(
            collector,
            "minecraft_status",
            return_value=public_result,
        ) as status:
            result = collector.collect_minecraft_probe(
                {"ivrm-velocity": proxy, "mc-main": backend}
            )
        self.assertEqual(status.call_count, 1)
        self.assertFalse(result["backend"]["reachable"])

    def test_probe_requires_fixed_containers(self) -> None:
        environment = {
            "IVRM_DOCKER_CONTAINERS": "mc-main,mc-resource-router",
            "IVRM_MINECRAFT_PROBE_ENABLED": "true",
        }
        with mock.patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ivrm-velocity"):
                collector.required_container_names()

    def test_probe_accepts_fixed_containers(self) -> None:
        environment = {
            "IVRM_DOCKER_CONTAINERS": "mc-main,ivrm-velocity",
            "IVRM_MINECRAFT_PROBE_ENABLED": "true",
        }
        with mock.patch.dict(os.environ, environment, clear=True):
            self.assertEqual(
                collector.required_container_names(),
                ["mc-main", "ivrm-velocity"],
            )


if __name__ == "__main__":
    unittest.main()
