#!/usr/bin/env python3
"""許可済みDockerコンテナとMinecraft疎通情報を限定JSONへ書き出す。"""

from __future__ import annotations

import grp
import ipaddress
import json
import os
import re
import socket
import struct
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

CONTAINER_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
SIZE_PATTERN = re.compile(r"^([0-9]+(?:\.[0-9]+)?)\s*([KMGTPE]?i?B|kB)$")
VALID_STATES = {
    "created",
    "running",
    "paused",
    "restarting",
    "removing",
    "exited",
    "dead",
}
VALID_HEALTH = {"starting", "healthy", "unhealthy"}
MAX_CONTAINERS = 20
MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_MINECRAFT_PACKET_BYTES = 2 * 1024 * 1024
MAX_MINECRAFT_PLAYERS = 1_000_000
MINECRAFT_PROXY_CONTAINER = "ivrm-velocity"
MINECRAFT_BACKEND_CONTAINER = "mc-main"
MINECRAFT_NETWORK = "minecraft-main_default"
MINECRAFT_PUBLIC_CONNECT_HOST = "127.0.0.1"
MINECRAFT_PUBLIC_HANDSHAKE_HOST = "mc.ivrm.jp"
MINECRAFT_BACKEND_HANDSHAKE_HOST = "mc-main"
MINECRAFT_PORT = 25565
RFC1918_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
SIZE_MULTIPLIERS = {
    "B": 1,
    "kB": 1_000,
    "KB": 1_000,
    "MB": 1_000**2,
    "GB": 1_000**3,
    "TB": 1_000**4,
    "PB": 1_000**5,
    "EB": 1_000**6,
    "KiB": 1_024,
    "MiB": 1_024**2,
    "GiB": 1_024**3,
    "TiB": 1_024**4,
    "PiB": 1_024**5,
    "EiB": 1_024**6,
}


def parse_boolean(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError("真偽値の設定が不正です")


def required_container_names() -> list[str]:
    raw = os.environ.get("IVRM_DOCKER_CONTAINERS", "")
    names = [name.strip() for name in raw.split(",") if name.strip()]
    if not names:
        raise RuntimeError("IVRM_DOCKER_CONTAINERSが設定されていません")
    if len(names) > MAX_CONTAINERS:
        raise RuntimeError(f"監視コンテナ数は{MAX_CONTAINERS}件以下にしてください")
    if len(names) != len(set(names)):
        raise RuntimeError("監視コンテナ名が重複しています")
    if any(not CONTAINER_NAME_PATTERN.fullmatch(name) for name in names):
        raise RuntimeError("不正なコンテナ名があります")

    if parse_boolean(os.environ.get("IVRM_MINECRAFT_PROBE_ENABLED")):
        required = {MINECRAFT_PROXY_CONTAINER, MINECRAFT_BACKEND_CONTAINER}
        if not required.issubset(names):
            raise RuntimeError(
                "Minecraft Probeにはivrm-velocityとmc-mainの監視登録が必要です"
            )
    return names


def empty_resource_metrics() -> dict[str, Any]:
    return {
        "cpuPercent": None,
        "memoryUsageBytes": None,
        "memoryLimitBytes": None,
        "networkRxBytes": None,
        "networkTxBytes": None,
        "blockReadBytes": None,
        "blockWriteBytes": None,
        "pids": None,
    }


def parse_size(value: str) -> int:
    match = SIZE_PATTERN.fullmatch(value.strip())
    if not match:
        raise ValueError(f"サイズ形式が不正です: {value!r}")
    number_text, unit = match.groups()
    try:
        result = int(Decimal(number_text) * SIZE_MULTIPLIERS[unit])
    except (InvalidOperation, KeyError) as exc:
        raise ValueError(f"サイズ形式が不正です: {value!r}") from exc
    if result < 0 or result > MAX_SAFE_INTEGER:
        raise ValueError(f"サイズが許容範囲外です: {value!r}")
    return result


def parse_size_pair(value: str) -> tuple[int, int]:
    parts = [part.strip() for part in value.split("/")]
    if len(parts) != 2:
        raise ValueError(f"サイズペア形式が不正です: {value!r}")
    return parse_size(parts[0]), parse_size(parts[1])


def parse_percent(value: str) -> float:
    text = value.strip()
    if not text.endswith("%"):
        raise ValueError(f"パーセント形式が不正です: {value!r}")
    try:
        result = float(Decimal(text[:-1]))
    except InvalidOperation as exc:
        raise ValueError(f"パーセント形式が不正です: {value!r}") from exc
    if result < 0 or result > 100_000:
        raise ValueError(f"パーセントが許容範囲外です: {value!r}")
    return result


def parse_pids(value: str) -> int:
    try:
        result = int(value.strip())
    except ValueError as exc:
        raise ValueError(f"PIDs形式が不正です: {value!r}") from exc
    if result < 0 or result > 2_147_483_647:
        raise ValueError(f"PIDsが許容範囲外です: {value!r}")
    return result


def collect_stats(docker_binary: str, name: str) -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [docker_binary, "stats", "--no-stream", "--format", "{{json .}}", name],
            check=False,
            capture_output=True,
            text=True,
            timeout=12,
            env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"docker statsがタイムアウトしました: {name}") from exc
    if completed.returncode != 0:
        raise RuntimeError(f"docker statsに失敗しました: {name}")

    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise RuntimeError(f"docker statsの応答件数が不正です: {name}")
    try:
        stats = json.loads(lines[0])
        memory_usage, memory_limit = parse_size_pair(stats["MemUsage"])
        network_rx, network_tx = parse_size_pair(stats["NetIO"])
        block_read, block_write = parse_size_pair(stats["BlockIO"])
        cpu_percent = parse_percent(stats["CPUPerc"])
        pids = parse_pids(stats["PIDs"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        raise RuntimeError(f"docker statsの応答形式が不正です: {name}") from exc
    if memory_usage > memory_limit:
        raise RuntimeError(f"docker statsのメモリ値が不正です: {name}")

    return {
        "cpuPercent": cpu_percent,
        "memoryUsageBytes": memory_usage,
        "memoryLimitBytes": memory_limit,
        "networkRxBytes": network_rx,
        "networkTxBytes": network_tx,
        "blockReadBytes": block_read,
        "blockWriteBytes": block_write,
        "pids": pids,
    }


def inspect_document(docker_binary: str, name: str) -> dict[str, Any] | None:
    completed = subprocess.run(
        [docker_binary, "inspect", name],
        check=False,
        capture_output=True,
        text=True,
        timeout=8,
        env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
    )
    if completed.returncode != 0:
        error_text = completed.stderr.lower()
        if "no such object" in error_text or "no such container" in error_text:
            return None
        raise RuntimeError(f"docker inspectに失敗しました: {name}")
    try:
        documents = json.loads(completed.stdout)
        document = documents[0]
        if not isinstance(document, dict) or not isinstance(document["State"], dict):
            raise TypeError
    except (json.JSONDecodeError, IndexError, KeyError, TypeError) as exc:
        raise RuntimeError(f"docker inspectの応答形式が不正です: {name}") from exc
    return document


def container_metrics(
    docker_binary: str,
    name: str,
    document: dict[str, Any] | None,
) -> dict[str, Any]:
    if document is None:
        return {
            "name": name,
            "state": "not_found",
            "health": "unknown",
            "restartCount": 0,
            "oomKilled": False,
            "exitCode": None,
            **empty_resource_metrics(),
        }

    state_data = document["State"]
    raw_state = state_data.get("Status")
    state = raw_state if raw_state in VALID_STATES else "unknown"
    health_data = state_data.get("Health")
    if isinstance(health_data, dict):
        raw_health = health_data.get("Status")
        health = raw_health if raw_health in VALID_HEALTH else "unknown"
    else:
        health = "none"

    restart_count = document.get("RestartCount", 0)
    if (
        not isinstance(restart_count, int)
        or isinstance(restart_count, bool)
        or restart_count < 0
    ):
        restart_count = 0
    oom_killed = state_data.get("OOMKilled") is True
    exit_code = state_data.get("ExitCode")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        exit_code = None

    resource_metrics = empty_resource_metrics()
    if state == "running":
        try:
            resource_metrics = collect_stats(docker_binary, name)
        except RuntimeError as exc:
            print(f"WARNING: {exc}", file=sys.stderr)

    return {
        "name": name,
        "state": state,
        "health": health,
        "restartCount": restart_count,
        "oomKilled": oom_killed,
        "exitCode": exit_code,
        **resource_metrics,
    }


def encode_varint(value: int) -> bytes:
    if value < 0 or value > 2_147_483_647:
        raise ValueError("VarIntが許容範囲外です")
    encoded = bytearray()
    while True:
        current = value & 0x7F
        value >>= 7
        if value:
            current |= 0x80
        encoded.append(current)
        if not value:
            return bytes(encoded)


def read_exact(connection: socket.socket, length: int) -> bytes:
    if length < 0 or length > MAX_MINECRAFT_PACKET_BYTES:
        raise RuntimeError("Minecraftパケット長が不正です")
    buffer = bytearray()
    while len(buffer) < length:
        chunk = connection.recv(length - len(buffer))
        if not chunk:
            raise RuntimeError("Minecraft応答が途中で終了しました")
        buffer.extend(chunk)
    return bytes(buffer)


def read_varint(connection: socket.socket) -> int:
    result = 0
    for index in range(5):
        current = read_exact(connection, 1)[0]
        result |= (current & 0x7F) << (7 * index)
        if current & 0x80 == 0:
            return result
    raise RuntimeError("Minecraft VarIntが長すぎます")


def encode_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    if len(encoded) > 255:
        raise ValueError("Minecraft接続先名が長すぎます")
    return encode_varint(len(encoded)) + encoded


def parse_status_response(value: Any) -> tuple[str, int, int]:
    if not isinstance(value, dict):
        raise RuntimeError("Minecraft応答JSONが不正です")
    version_data = value.get("version")
    players_data = value.get("players")
    if not isinstance(version_data, dict) or not isinstance(players_data, dict):
        raise RuntimeError("Minecraft応答に必要な情報がありません")

    version = version_data.get("name")
    online = players_data.get("online")
    maximum = players_data.get("max")
    if (
        not isinstance(version, str)
        or not version.strip()
        or len(version) > 128
        or not isinstance(online, int)
        or isinstance(online, bool)
        or not isinstance(maximum, int)
        or isinstance(maximum, bool)
        or online < 0
        or maximum < 1
        or online > maximum
        or maximum > MAX_MINECRAFT_PLAYERS
    ):
        raise RuntimeError("Minecraft応答値が許容範囲外です")
    return version.strip(), online, maximum


def minecraft_status(
    connect_host: str,
    handshake_host: str,
    port: int = MINECRAFT_PORT,
    timeout: float = 3.0,
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        handshake = (
            encode_varint(0)
            + encode_varint(47)
            + encode_string(handshake_host)
            + struct.pack(">H", port)
            + encode_varint(1)
        )
        with socket.create_connection((connect_host, port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            connection.sendall(encode_varint(len(handshake)) + handshake)
            connection.sendall(b"\x01\x00")

            packet_length = read_varint(connection)
            if packet_length < 2 or packet_length > MAX_MINECRAFT_PACKET_BYTES:
                raise RuntimeError("Minecraft応答パケット長が不正です")
            packet_id = read_varint(connection)
            if packet_id != 0:
                raise RuntimeError("Minecraft応答パケットIDが不正です")
            json_length = read_varint(connection)
            if json_length < 2 or json_length > MAX_MINECRAFT_PACKET_BYTES:
                raise RuntimeError("Minecraft応答JSON長が不正です")
            document = json.loads(read_exact(connection, json_length).decode("utf-8"))

        version, online, maximum = parse_status_response(document)
        latency_ms = max(0, min(60_000, round((time.monotonic() - started) * 1_000)))
        return {
            "reachable": True,
            "latencyMs": latency_ms,
            "version": version,
            "online": online,
            "max": maximum,
        }
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RuntimeError, ValueError) as exc:
        print(
            f"WARNING: Minecraft Pingに失敗しました: {handshake_host}: {exc}",
            file=sys.stderr,
        )
        return {
            "reachable": False,
            "latencyMs": None,
            "version": None,
            "online": None,
            "max": None,
        }


def is_port_published(document: dict[str, Any] | None, key: str) -> bool:
    if document is None:
        return False
    host_config = document.get("HostConfig")
    network_settings = document.get("NetworkSettings")
    if isinstance(host_config, dict):
        bindings = host_config.get("PortBindings")
        if isinstance(bindings, dict) and bindings.get(key):
            return True
    if isinstance(network_settings, dict):
        ports = network_settings.get("Ports")
        if isinstance(ports, dict) and ports.get(key):
            return True
    return False


def fixed_network_attachment(
    document: dict[str, Any] | None,
) -> tuple[str, str] | None:
    if document is None:
        return None
    network_settings = document.get("NetworkSettings")
    if not isinstance(network_settings, dict):
        return None
    networks = network_settings.get("Networks")
    if not isinstance(networks, dict):
        return None
    network = networks.get(MINECRAFT_NETWORK)
    if not isinstance(network, dict):
        return None

    raw_ip = network.get("IPAddress")
    network_id = network.get("NetworkID")
    if not isinstance(raw_ip, str) or not isinstance(network_id, str) or not network_id:
        return None
    try:
        address = ipaddress.ip_address(raw_ip)
    except ValueError:
        return None
    if address.version != 4 or not any(address in subnet for subnet in RFC1918_NETWORKS):
        return None
    return str(address), network_id


def backend_ip(document: dict[str, Any] | None) -> str | None:
    attachment = fixed_network_attachment(document)
    return attachment[0] if attachment else None


def collect_minecraft_probe(
    documents: dict[str, dict[str, Any] | None],
) -> dict[str, Any]:
    proxy_document = documents.get(MINECRAFT_PROXY_CONTAINER)
    backend_document = documents.get(MINECRAFT_BACKEND_CONTAINER)
    proxy_attachment = fixed_network_attachment(proxy_document)
    backend_attachment = fixed_network_attachment(backend_document)
    internal_ip = (
        backend_attachment[0]
        if proxy_attachment
        and backend_attachment
        and proxy_attachment[1] == backend_attachment[1]
        else None
    )

    public_status = minecraft_status(
        MINECRAFT_PUBLIC_CONNECT_HOST,
        MINECRAFT_PUBLIC_HANDSHAKE_HOST,
    )
    backend_status = (
        minecraft_status(internal_ip, MINECRAFT_BACKEND_HANDSHAKE_HOST)
        if internal_ip
        else {
            "reachable": False,
            "latencyMs": None,
            "version": None,
            "online": None,
            "max": None,
        }
    )

    return {
        "publicEndpoint": public_status,
        "backend": backend_status,
        "proxyPortPublished": is_port_published(proxy_document, "25565/tcp"),
        "backendPortPublished": is_port_published(backend_document, "25565/tcp"),
        "voiceChatPortPublished": is_port_published(backend_document, "24454/udp"),
    }


def write_snapshot(
    output_path: Path,
    containers: list[dict[str, Any]],
    minecraft: dict[str, Any] | None,
) -> None:
    output_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    payload: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "containers": containers,
    }
    if minecraft is not None:
        payload["minecraft"] = minecraft

    group_id = grp.getgrnam("ivrm-agent").gr_gid
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="docker-state-",
        suffix=".json",
        dir=output_path.parent,
        text=True,
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(payload, file, separators=(",", ":"), ensure_ascii=True)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.chown(temporary_path, 0, group_id)
        os.chmod(temporary_path, 0o640)
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def main() -> None:
    docker_binary = os.environ.get("IVRM_DOCKER_BINARY", "/usr/bin/docker")
    output_path = Path(
        os.environ.get(
            "IVRM_DOCKER_SNAPSHOT_PATH",
            "/run/ivrm-agent/docker-state.json",
        )
    )
    if not output_path.is_absolute():
        raise RuntimeError("IVRM_DOCKER_SNAPSHOT_PATHは絶対パスにしてください")

    names = required_container_names()
    documents = {name: inspect_document(docker_binary, name) for name in names}
    containers = [
        container_metrics(docker_binary, name, documents[name]) for name in names
    ]
    minecraft = (
        collect_minecraft_probe(documents)
        if parse_boolean(os.environ.get("IVRM_MINECRAFT_PROBE_ENABLED"))
        else None
    )
    write_snapshot(output_path, containers, minecraft)


if __name__ == "__main__":
    main()
