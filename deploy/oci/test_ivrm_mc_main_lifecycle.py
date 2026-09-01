import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from typing import Optional
from unittest import mock

MODULE_PATH = Path(__file__).with_name("ivrm-mc-main-lifecycle.py")
spec = importlib.util.spec_from_file_location("ivrm_mc_main_lifecycle", MODULE_PATH)
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


class LifecycleTest(unittest.TestCase):
    def test_action_allowlist_has_only_phase_b1_actions(self):
        self.assertEqual(module.ACTIONS, {"start_backend", "restart_backend", "stop_backend"})

    def test_execution_defaults_off(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertFalse(module.execution_enabled())

    def _request(self, directory: str, extra: Optional[dict] = None) -> Path:
        job_id = "123e4567-e89b-42d3-a456-426614174000"
        path = Path(directory) / f"{job_id}.json"
        payload = {"jobId": job_id, "action": "start_backend"}
        if extra:
            payload.update(extra)
        path.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def test_parse_rejects_arbitrary_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._request(directory, {"command": "docker ps"})
            with self.assertRaises(ValueError):
                module.parse_request(path)

    def test_parse_rejects_group_writable_request(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._request(directory)
            os.chmod(path, 0o660)
            with self.assertRaises(ValueError):
                module.parse_request(path)

    def test_parse_rejects_stale_request(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._request(directory)
            old = time.time() - module.REQUEST_MAX_AGE_SECONDS - 1
            os.utime(path, (old, old))
            with self.assertRaises(ValueError):
                module.parse_request(path)

    @mock.patch.object(module, "wait_stopped", return_value=True)
    @mock.patch.object(module, "run_docker")
    @mock.patch.object(module, "inspect_state", return_value=("running", "healthy"))
    def test_stop_uses_term_and_never_kill_escalation(self, inspect, run_docker, wait_stopped):
        run_docker.return_value.returncode = 0
        ok, phase = module.graceful_stop()
        self.assertTrue(ok)
        self.assertEqual(phase, "stopped")
        run_docker.assert_called_once_with("kill", "--signal=TERM", "mc-main")

    @mock.patch.object(module, "wait_healthy", return_value=True)
    @mock.patch.object(module, "run_docker")
    @mock.patch.object(module, "inspect_state", return_value=("exited", "none"))
    def test_start_targets_fixed_container(self, inspect, run_docker, wait_healthy):
        run_docker.return_value.returncode = 0
        ok, phase = module.safe_start()
        self.assertTrue(ok)
        self.assertEqual(phase, "health_gate_passed")
        run_docker.assert_called_once_with("start", "mc-main")

    @mock.patch.object(module, "safe_start", return_value=(True, "health_gate_passed"))
    @mock.patch.object(module, "graceful_stop", return_value=(True, "stopped"))
    def test_restart_is_stop_then_start(self, graceful_stop, safe_start):
        ok, phase, error = module.execute("restart_backend")
        self.assertTrue(ok)
        self.assertEqual(phase, "health_gate_passed")
        self.assertIsNone(error)
        graceful_stop.assert_called_once()
        safe_start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
