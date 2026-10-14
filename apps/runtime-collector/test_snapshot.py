import copy
import subprocess
import unittest

from snapshot import collect, normalize, PROFILES


def document():
    return {"state": "running", "health": "healthy", "restartCount": 0,
            "oomKilled": False, "exitCode": 0, "image": "registry.example/service:commit",
            "imageId": "sha256:" + "a" * 64}


class RuntimeInventoryTests(unittest.TestCase):
    def test_only_fixed_inspection_is_executed(self):
        calls = []
        def read(argv):
            calls.append(argv)
            return document()
        result = collect("aws-app-01", read)
        self.assertEqual(len(result["containers"]), len(PROFILES["aws-app-01"]))
        self.assertTrue(all(x["collection"] == "ok" for x in result["containers"]))
        for argv in calls:
            self.assertEqual(argv[:4], ["/usr/bin/docker", "container", "inspect", "--format"])
            self.assertIn(argv[-1], PROFILES["aws-app-01"])
            self.assertNotIn(".Config.Env", argv[4])
        with self.assertRaises(ValueError):
            collect("aws-app-01; reboot", read)

    def test_denial_missing_and_timeout_are_not_healthy(self):
        for error in (ValueError("private provider message"), PermissionError(), subprocess.TimeoutExpired("docker", 15)):
            def read(_):
                raise error
            result = collect("lightsail-herta", read)
            self.assertTrue(all(set(x) == {"name", "collection"} and x["collection"] == "unavailable" for x in result["containers"]))
            self.assertNotIn("private provider message", str(result))

    def test_projection_rejects_secret_fields_and_invalid_values(self):
        for key, value in (("env", "secret"), ("image", "https://user:secret@host/?token=secret"),
                           ("imageId", "invalid"), ("restartCount", True), ("oomKilled", "false"),
                           ("exitCode", -1), ("state", "unknown_raw_output")):
            row = copy.deepcopy(document())
            row[key] = value
            with self.assertRaises(ValueError):
                normalize(row)

    def test_completed_or_optional_workloads_are_not_required(self):
        self.assertNotIn("herta-migrator-1", PROFILES["lightsail-herta"])
        self.assertNotIn("mc-resource", PROFILES["oci-minecraft-01"])


if __name__ == "__main__":
    unittest.main()
