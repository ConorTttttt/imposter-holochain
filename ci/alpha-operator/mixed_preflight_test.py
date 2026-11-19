import http.client
from importlib.util import module_from_spec, spec_from_file_location
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("mixed-browser-run.py")
sys.path.insert(0, str(SCRIPT.parent))
spec = spec_from_file_location("mixed_browser_run", SCRIPT)
runner = module_from_spec(spec)
spec.loader.exec_module(runner)


class OperatorPreflightTest(unittest.TestCase):
    def test_missing_config_has_a_sanitized_report(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.json"
            result = subprocess.run([
                sys.executable, str(SCRIPT), "operator", "--config",
                str(Path(directory) / "private.json"), "--report", str(output),
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(output.read_text())["failure"], "OPERATOR_CONFIGURATION_MISSING")
            self.assertNotIn(directory, result.stderr)

    def test_network_failures_keep_distinct_stage_codes(self):
        for error, stage in [
            (ConnectionRefusedError("private endpoint"), "OPERATOR_NETWORK_OR_TAILSCALE_UNREACHABLE"),
            (ssl.SSLError("private certificate"), "OPERATOR_TLS_TRUST_OR_CERTIFICATE"),
            (http.client.BadStatusLine("private endpoint"), "OPERATOR_SERVED_RELEASE_OR_GATEWAY_MISMATCH"),
            (ValueError("private response body"), "OPERATOR_SERVED_RELEASE_OR_GATEWAY_MISMATCH"),
        ]:
            with self.subTest(stage=stage), patch.object(runner, "remote_preflight", side_effect=error), \
                    patch.object(runner, "which", return_value=None):
                with self.assertRaisesRegex(runner.GateError, "^" + stage + "$"):
                    runner.check_operator_network({}, Path("."))

    def test_local_tailscale_status_can_confirm_no_connectivity(self):
        with patch.object(runner, "remote_preflight", side_effect=ConnectionError), \
                patch.object(runner, "which", return_value="tailscale"), \
                patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, stdout='{"BackendState": "NeedsLogin"}')):
            with self.assertRaisesRegex(runner.GateError, "^OPERATOR_TAILSCALE_OFFLINE$"):
                runner.check_operator_network({}, Path("."))

    def test_private_inputs_must_be_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "private.json"
            config.write_text("{}")
            os.chmod(config, 0o644)
            self.assertFalse(runner.private(config))
            os.chmod(config, 0o600)
            self.assertTrue(runner.private(config))
