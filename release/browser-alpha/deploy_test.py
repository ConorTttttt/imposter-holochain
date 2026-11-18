from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from deploy import admin_secret, browser_config, configuration, place_static, proxy_config
from package import EXTENSION, archive_extension, check_extension, verify_public_bytes


class DeploymentTests(TestCase):
    def setUp(self):
        self.public = {
            "frontend_origin": "https://game.example.test",
            "gateway_origin": "https://link.example.test",
            "bootstrap_url": "https://bootstrap.example.test/kitsune/",
            "relay_url": "https://relay.example.test",
        }
        self.operator = {
            "static_root": "/srv/imposter-alpha",
            "gateway_identity_file": "/var/lib/imposter/identity",
            "gateway_session_db": "/var/lib/imposter/sessions",
            "admin_secret_file": "/etc/imposter/admin-secret",
            "native_authority_root": "/var/lib/imposter/native",
        }

    def test_proxy_and_browser_config_emit_only_intended_settings(self):
        public, paths = configuration(self.public, self.operator)
        self.assertEqual(set(browser_config(public)), {"frontend_origin", "gateway_origin"})
        text = proxy_config(public, paths)
        self.assertIn("reverse_proxy 127.0.0.1:8090", text)
        self.assertIn("@admin path /admin /admin/*", text)
        self.assertIn("respond @admin 404", text)
        self.assertIn(self.operator["static_root"], text)
        for key in set(self.operator) - {"static_root"}:
            self.assertNotIn(self.operator[key], text)

    def test_reject_insecure_or_ambiguous_gateway_urls(self):
        for url in ("http://link.example.test", "wss://link.example.test", "https://link.example.test/",
                    "https://operator@link.example.test", "https://link.example.test?key=test",
                    "https://127.0.0.1:8090", "https://[::1]", "https://link.example.test:443"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                configuration({**self.public, "gateway_origin": url}, self.operator)

    def test_reject_development_bootstrap_and_public_operator_settings(self):
        with self.assertRaises(ValueError):
            configuration({**self.public, "bootstrap_url": "https://dev-test-bootstrap2.holochain.org/"}, self.operator)
        with self.assertRaises(ValueError):
            configuration({**self.public, "admin_secret_file": self.operator["admin_secret_file"]}, self.operator)
        with self.assertRaises(ValueError):
            configuration(self.public, {**self.operator, "admin_secret_file": "/srv/imposter-alpha/secret"})

    def test_static_publication_is_idempotent_and_rejects_drift(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = {"browser-setup.html": b"bootstrap"}
            place_static(root, files)
            place_static(root, {**files, "deployment.json": b"{}"})
            with self.assertRaises(ValueError):
                place_static(root, {"browser-setup.html": b"unexpected"})
            self.assertEqual((root / "browser-setup.html").read_bytes(), b"bootstrap")

    def test_secret_file_must_be_private(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "test-only"
            path.write_text("0" * 64)
            path.chmod(0o640)
            with self.assertRaises(ValueError):
                admin_secret(path)
            path.chmod(0o600)
            self.assertEqual(len(admin_secret(path)), 64)


class ArchiveTests(TestCase):
    def test_extension_archive_is_deterministic_and_excludes_maps(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "extension"
            (source / "background").mkdir(parents=True)
            (source / "manifest.json").write_text(
                '{"manifest_version":3,"version":"1","background":{"service_worker":"background/index.js"}}'
            )
            script = source / "background/index.js"
            script.write_text("/* test fixture only */")
            (source / "background/index.js.map").write_text("{}")
            one, two = root / EXTENSION, root / "second.zip"
            archive_extension(source, one)
            script.touch()
            archive_extension(source, two)
            self.assertEqual(one.read_bytes(), two.read_bytes())
            self.assertEqual(check_extension(one), "1")
            script.write_text("__imposterRoleFixture")
            archive_extension(source, one)
            with self.assertRaisesRegex(ValueError, "CI instrumentation"):
                check_extension(one)

    def test_secret_scan_rejects_private_key_material_marker(self):
        with self.assertRaisesRegex(ValueError, "Private credential"):
            verify_public_bytes(b"-----BEGIN PRIVATE KEY-----", "fixture")
