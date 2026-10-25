from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("ivrm-backup-evidence.py")
SPEC = importlib.util.spec_from_file_location("ivrm_backup_evidence", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def archive(path: Path, names: list[str], bodies: dict[str, bytes] | None = None) -> None:
    with tarfile.open(path, "w:gz") as output:
        for name in names:
            body = (bodies or {}).get(name, b"test")
            info = tarfile.TarInfo(name)
            info.size = len(body)
            output.addfile(info, io.BytesIO(body))


class BackupEvidenceTests(unittest.TestCase):
    def test_accepts_world_archive_and_hashes_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            archive(path, ["data/world/level.dat", "data/world/region/r.0.0.mca"])
            result = MODULE.inspect_archive(path)
            digest = hashlib.sha256(path.read_bytes()).digest()
            self.assertEqual(result["sha256Hex"], digest.hex())
            self.assertEqual(result["sha256Base64"], base64.b64encode(digest).decode())
            self.assertEqual(result["worldMarkerCount"], 1)

    def test_rejects_rcon_runtime_files(self):
        for name in ["data/.rcon-cli.env", "data/.rcon-cli.yaml"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "backup.tar.gz"
                archive(path, ["data/world/level.dat", name])
                with self.assertRaisesRegex(MODULE.EvidenceError, "sensitive_runtime_file"):
                    MODULE.inspect_archive(path)

    def test_rejects_server_properties_even_if_rcon_password_is_empty(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            names = ["data/world/level.dat", "data/server.properties"]
            archive(path, names, {"data/server.properties": b"motd=test\nrcon.password=\n"})
            with self.assertRaisesRegex(MODULE.EvidenceError, "sensitive_runtime_file"):
                MODULE.inspect_archive(path)

    def test_rejects_secrets_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            archive(path, ["data/world/level.dat", "secrets/token"])
            with self.assertRaisesRegex(MODULE.EvidenceError, "sensitive_runtime_file"):
                MODULE.inspect_archive(path)

    def test_rejects_archive_without_world_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            archive(path, ["data/config/example.conf"])
            with self.assertRaisesRegex(MODULE.EvidenceError, "world_marker_missing"):
                MODULE.inspect_archive(path)

    def test_rejects_symlink_named_like_world_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            with tarfile.open(path, "w:gz") as output:
                info = tarfile.TarInfo("data/world/level.dat")
                info.type = tarfile.SYMTYPE
                info.linkname = "/etc/passwd"
                output.addfile(info)
            with self.assertRaisesRegex(MODULE.EvidenceError, "world_marker_missing"):
                MODULE.inspect_archive(path)

    def test_rejects_parent_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            archive(path, ["data/world/level.dat", "../../outside"])
            with self.assertRaisesRegex(MODULE.EvidenceError, "archive_path_unsafe"):
                MODULE.inspect_archive(path)

    def test_rejects_corrupt_gzip_trailer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "backup.tar.gz"
            archive(path, ["data/world/level.dat"])
            value = bytearray(path.read_bytes())
            value[-8] ^= 0xFF
            path.write_bytes(value)
            with self.assertRaisesRegex(MODULE.EvidenceError, "archive_invalid"):
                MODULE.inspect_archive(path)

    def test_remote_verification_requires_size_and_sha256(self):
        local = {"sizeBytes": 4, "sha256Base64": "YWJjZA==", "sha256Hex": "61626364"}
        valid = {
            "ContentLength": 4,
            "ChecksumSHA256": "composite-or-full-checksum",
            "Metadata": {"ivrm-sha256": "61626364"},
        }
        MODULE.verify_remote(local, valid)
        for head in [
            {**valid, "ContentLength": 3},
            {**valid, "Metadata": {"ivrm-sha256": "wrong"}},
            {"ContentLength": 4},
        ]:
            with self.subTest(head=json.dumps(head)):
                with self.assertRaises(MODULE.EvidenceError):
                    MODULE.verify_remote(local, head)


if __name__ == "__main__":
    unittest.main()
