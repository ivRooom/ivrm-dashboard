#!/usr/bin/env python3
"""Validate Minecraft backup archives and emit non-secret integrity evidence."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import tarfile
from pathlib import Path, PurePosixPath

FORBIDDEN_BASENAMES = {
    ".rcon-cli.env",
    ".rcon-cli.yaml",
}
WORLD_MARKERS = {"level.dat"}


class EvidenceError(ValueError):
    pass


def safe_member_name(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise EvidenceError("archive_path_unsafe")
    return path


def inspect_archive(path: Path) -> dict[str, object]:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)

    sha256_bytes = digest.digest()
    forbidden: list[str] = []
    world_markers: list[str] = []

    try:
        with tarfile.open(path, "r:gz") as archive:
            for member in archive:
                member_path = safe_member_name(member.name)
                if member_path.name in FORBIDDEN_BASENAMES:
                    forbidden.append(member.name)
                if member.isfile() and member_path.name in WORLD_MARKERS:
                    world_markers.append(member.name)
    except (tarfile.TarError, OSError) as error:
        raise EvidenceError("archive_invalid") from error

    if forbidden:
        raise EvidenceError("archive_contains_sensitive_runtime_file")
    if not world_markers:
        raise EvidenceError("world_marker_missing")

    return {
        "sizeBytes": path.stat().st_size,
        "sha256Hex": sha256_bytes.hex(),
        "sha256Base64": base64.b64encode(sha256_bytes).decode("ascii"),
        "worldMarkerCount": len(world_markers),
    }


def verify_remote(local: dict[str, object], head: dict[str, object]) -> None:
    remote_size = head.get("ContentLength")
    remote_checksum = head.get("ChecksumSHA256")
    metadata = head.get("Metadata")
    remote_source_hash = metadata.get("ivrm-sha256") if isinstance(metadata, dict) else None
    if remote_size != local["sizeBytes"]:
        raise EvidenceError("remote_size_mismatch")
    if not isinstance(remote_checksum, str) or not remote_checksum:
        raise EvidenceError("remote_checksum_missing")
    if remote_source_hash != local["sha256Hex"]:
        raise EvidenceError("remote_source_hash_mismatch")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=Path)
    parser.add_argument("--head-json", type=Path)
    args = parser.parse_args()

    evidence = inspect_archive(args.archive)
    if args.head_json:
        head = json.loads(args.head_json.read_text(encoding="utf-8"))
        verify_remote(evidence, head)
        evidence["remoteVerified"] = True
    else:
        evidence["remoteVerified"] = False

    print(json.dumps(evidence, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
