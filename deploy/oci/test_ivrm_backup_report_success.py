import importlib.util
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE_PATH = Path(__file__).with_name("ivrm-backup-report-success.py")
SPEC = importlib.util.spec_from_file_location("ivrm_backup_report_success", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class BackupReportSuccessTests(unittest.TestCase):
    def test_reports_sha_verified_only_with_remote_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup = root / "minecraft-main-20261024-150000.tar.gz"
            backup.write_bytes(b"archive")
            marker = root / "start.marker"
            marker.touch()
            os.utime(marker, (backup.stat().st_mtime - 1, backup.stat().st_mtime - 1))
            evidence_dir = root / "evidence"
            evidence_dir.mkdir()
            (evidence_dir / f"{backup.name}.json").write_text(json.dumps({
                "remoteVerified": True,
                "sizeBytes": backup.stat().st_size,
                "sha256Hex": "a" * 64,
            }))
            with mock.patch.object(MODULE, "BACKUP_DIR", root), mock.patch.object(
                MODULE, "MARKER", marker
            ), mock.patch.object(MODULE, "EVIDENCE_DIR", evidence_dir):
                runs = MODULE.build_runs("oci-minecraft-01")
            self.assertEqual(len(runs), 1)
            self.assertIs(runs[0]["sha256Verified"], True)
            self.assertIsNone(runs[0]["restoreTestedAt"])
            self.assertIsNone(runs[0]["retentionExpiresAt"])

    def test_rejects_unverified_remote_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "minecraft-main-20261024-150000.tar.gz"
            path.write_bytes(b"archive")
            evidence = Path(directory) / "evidence"
            evidence.mkdir()
            (evidence / f"{path.name}.json").write_text(json.dumps({
                "remoteVerified": False,
                "sizeBytes": path.stat().st_size,
                "sha256Hex": "a" * 64,
            }))
            with mock.patch.object(MODULE, "EVIDENCE_DIR", evidence):
                with self.assertRaisesRegex(ValueError, "remote_verification_missing"):
                    MODULE.verified_evidence(path)


if __name__ == "__main__":
    unittest.main()
