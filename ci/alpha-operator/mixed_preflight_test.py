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
from unittest.mock import Mock, patch
from zipfile import ZIP_STORED, ZipFile

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
        for origin, error, stage in [
            ("GATEWAY", ConnectionRefusedError("private endpoint"), "OPERATOR_GATEWAY_UNREACHABLE"),
            ("FRONTEND", ssl.SSLError("private certificate"), "OPERATOR_FRONTEND_TLS_TRUST_OR_CERTIFICATE"),
            ("GATEWAY", http.client.BadStatusLine("private endpoint"), "OPERATOR_GATEWAY_RESPONSE_MISMATCH"),
            ("FRONTEND", ValueError("private response body"), "OPERATOR_FRONTEND_RESPONSE_MISMATCH"),
        ]:
            with self.subTest(stage=stage), patch.object(runner, "which", return_value=None):
                with self.assertRaisesRegex(runner.GateError, "^" + stage + "$"):
                    runner.check_operator_origin(origin, Mock(side_effect=error))

    def test_local_tailscale_status_can_confirm_no_connectivity(self):
        with patch.object(runner, "which", return_value="tailscale"), \
                patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, stdout='{"BackendState": "NeedsLogin"}')):
            with self.assertRaisesRegex(runner.GateError, "^OPERATOR_TAILSCALE_OFFLINE$"):
                runner.check_operator_origin("GATEWAY", Mock(side_effect=ConnectionError))

    def test_private_inputs_must_be_owner_only(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "private.json"
            config.write_text("{}")
            os.chmod(config, 0o644)
            self.assertFalse(runner.private(config))
            os.chmod(config, 0o600)
            self.assertTrue(runner.private(config))

    def test_evidence_path_refuses_to_replace_a_symlink_or_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "keep.json"
            target.write_text("original")
            link = root / "link.json"
            link.symlink_to(target)
            for destination in (target, link):
                result = subprocess.run([sys.executable, str(SCRIPT), "operator",
                                         "--config", str(root / "private.json"), "--report", str(destination)],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr.strip(), "OPERATOR_EVIDENCE_PATH_UNAVAILABLE=FAIL")
            self.assertEqual(target.read_text(), "original")

    def test_chromium_inventory_matches_bytes_across_zip_compression_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tree = root / "chromium"
            tree.mkdir()
            bundle = root / "release.zip"
            with ZipFile(bundle, "w", compression=ZIP_STORED) as archive:
                archive.writestr("manifest.json", b"test manifest")
            (tree / "manifest.json").write_bytes(b"test manifest")
            (tree / "index.js.map").write_bytes(b"excluded by release packaging")
            runner.verify_chromium_tree(tree, bundle)
            (tree / "manifest.json").write_bytes(b"different")
            with self.assertRaisesRegex(runner.GateError, "CHROMIUM_EXTENSION_NOT_EXACT_RELEASE"):
                runner.verify_chromium_tree(tree, bundle)

    def test_firefox_accepts_two_entry_ci_checksum_file_after_pinning_zip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, packages, scratch = (root / name for name in ("source", "packages", "scratch"))
            for path in (source, packages, scratch):
                path.mkdir()
            (source / "manifest.json").write_text(json.dumps({
                "manifest_version": 3, "background": {"scripts": ["background/index.js"]},
                "browser_specific_settings": {"gecko": {"id": "holochain@holo.host"}},
            }))
            for file in ("background/index.js", "content/index.js", "inject/index.js",
                         "offscreen/ribosome-worker.js", "offscreen/sqlite3.wasm", "popup/index.html"):
                entry = source / file
                entry.parent.mkdir(exist_ok=True)
                entry.write_bytes(b"\0asm\1\0\0\0" if entry.suffix == ".wasm" else b"fixture")
            bundle = packages / "firefox-desktop-hwc.zip"
            runner.archive_extension(source, bundle)
            sha = runner.digest(bundle)
            (packages / "SHA256SUMS").write_text(f"{'1' * 64}  chromium-hwc.zip\n{sha}  {bundle.name}\n")
            extracted = runner.stage_firefox(packages, sha, scratch)
            self.assertEqual((extracted / "manifest.json").read_bytes(), (source / "manifest.json").read_bytes())
            other = root / "other"
            other.mkdir()
            with self.assertRaisesRegex(runner.GateError, "FIREFOX_EXTENSION_CHECKSUM"):
                runner.stage_firefox(packages, "0" * 64, other)

    def test_a_concurrent_operator_runner_cannot_reuse_the_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            profiles = [Path(directory) / str(index) for index in range(3)]
            for profile in profiles:
                profile.mkdir()
            with runner.lock_profiles(profiles):
                with self.assertRaisesRegex(runner.GateError, "OPERATOR_PROFILE_IN_USE"):
                    with runner.lock_profiles(profiles):
                        self.fail("overlapping operator runner")
            with runner.lock_profiles(profiles):
                pass

    def test_operator_browser_environment_excludes_gateway_administrator_variables(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "H2HC_LINKER_ADMIN_SECRET": "fixture", "FIREFOX_BIN": "/test/firefox",
        }), patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as child:
            scratch = Path(directory)
            runner.launch("preflight", {"mode": "operator"}, scratch, scratch / "report.json")
            env = child.call_args.kwargs["env"]
            self.assertEqual(env["FIREFOX_BIN"], "/test/firefox")
            self.assertNotIn("H2HC_LINKER_ADMIN_SECRET", env)
