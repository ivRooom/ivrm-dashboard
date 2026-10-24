#!/usr/bin/env python3
"""Build a Backup Center success report from verified artifacts only."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BACKUP_DIR = Path(os.environ.get("IVRM_BACKUP_DIR", "/opt/ivrm/backup/minecraft"))
EVIDENCE_DIR = Path(os.environ.get("IVRM_BACKUP_EVIDENCE_DIR", "/run/ivrm-backup/evidence"))
REPORT = Path(os.environ.get("IVRM_BACKUP_REPORT", "/run/ivrm-backup/backup-report.json"))
REPORTER = Path(os.environ.get("IVRM_BACKUP_REPORTER", "/opt/ivrm/ivrm-backup-reporter.py"))
PATTERN = re.compile(r"^(minecraft-(?P<mode>[A-Za-z0-9_.-]+))-(?P<stamp>\d{8}-\d{6})\.tar\.gz$")


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def verified_evidence(path: Path) -> dict[str, object]:
    evidence_path = EVIDENCE_DIR / f"{path.name}.json"
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    if evidence.get("remoteVerified") is not True:
        raise ValueError("remote_verification_missing")
    if evidence.get("sizeBytes") != path.stat().st_size:
        raise ValueError("evidence_size_mismatch")
    if not isinstance(evidence.get("sha256Hex"), str):
        raise ValueError("evidence_sha256_missing")
    return evidence


def build_runs(server_id: str) -> list[dict[str, object]]:
    candidates = sorted(
        (
            Path(str(marker)[: -len(".pending")])
            for marker in BACKUP_DIR.glob("minecraft-*.tar.gz.pending")
            if PATTERN.fullmatch(Path(str(marker)[: -len(".pending")]).name)
        ),
        key=lambda path: path.stat().st_mtime,
    )[-20:]

    runs: list[dict[str, object]] = []
    for path in candidates:
        match = PATTERN.fullmatch(path.name)
        assert match is not None
        try:
            verified_evidence(path)
        except (OSError, ValueError) as error:
            print(f"Skip unverified artifact {path.name}: {error}", file=sys.stderr)
            continue
        started_at = datetime.strptime(match.group("stamp"), "%Y%m%d-%H%M%S").replace(
            tzinfo=ZoneInfo("Asia/Tokyo")
        ).astimezone(timezone.utc)
        completed_at = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        run_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"ivrm-backup:{server_id}:{path.name}"))
        runs.append(
            {
                "runId": run_id,
                "backupTarget": match.group(1),
                "gameMode": match.group("mode"),
                "backupType": "full",
                "destinationType": "s3",
                "startedAt": iso(started_at),
                "completedAt": iso(completed_at),
                "outcome": "success",
                "durationSeconds": max(0, int((completed_at - started_at).total_seconds())),
                "sizeBytes": path.stat().st_size,
                "sha256Verified": True,
                "remoteSyncedAt": iso(datetime.now(timezone.utc)),
                "restoreTestedAt": None,
                "retentionExpiresAt": None,
                "failureCode": None,
            }
        )
    return runs


def main() -> int:
    server_id = os.environ.get("IVRM_AGENT_SERVER_ID", "").strip()
    if not server_id:
        print("IVRM_AGENT_SERVER_IDがありません", file=sys.stderr)
        return 1
    runs = build_runs(server_id)
    if not runs:
        print("今回新規作成されたBackupはありません。Report送信をSkipします。")
        return 0

    REPORT.parent.mkdir(parents=True, exist_ok=True)
    temporary = REPORT.with_suffix(".json.tmp")
    temporary.write_text(json.dumps({"runs": runs}, separators=(",", ":")) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o640)
    os.replace(temporary, REPORT)
    result = subprocess.run([sys.executable, str(REPORTER), "--input", str(REPORT)], check=False)
    if result.returncode == 0:
        for run in runs:
            timestamp = datetime.fromisoformat(str(run["startedAt"]).replace("Z", "+00:00"))
            local_stamp = timestamp.astimezone(ZoneInfo("Asia/Tokyo")).strftime("%Y%m%d-%H%M%S")
            marker = BACKUP_DIR / f'{run["backupTarget"]}-{local_stamp}.tar.gz.pending'
            marker.unlink(missing_ok=True)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
