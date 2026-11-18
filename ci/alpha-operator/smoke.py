#!/usr/bin/env python3
"""Loopback TLS and operator lifecycle smoke using the real release and gateway."""
from contextlib import contextmanager
import http.client
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "release/browser-alpha"))
from deploy import (admission_status, change_admission, configuration, gateway_environment,
                    https_request, proxy_config, release_files, remote_preflight)
from package import GATEWAY, SETUP, digest, verify
from site_release import activate_site

FRONT = "rc1-front.example.test"
GATE = "rc1-gateway.example.test"


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for(port, process):
    start = time.monotonic()
    while time.monotonic() - start < 25:
        if process.poll() is not None:
            raise RuntimeError("An operator fixture service exited during startup")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("Operator fixture service did not listen")


@contextmanager
def service(command, port, root, env):
    # Logs and all gateway material stay in the private TemporaryDirectory.
    with (root / f"{port}.local.log").open("wb") as log:
        child = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=log)
        try:
            wait_for(port, child)
            yield
        finally:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def local_gateway_health():
    connection = http.client.HTTPConnection("127.0.0.1", 8090, timeout=5)
    try:
        connection.request("GET", "/health")
        assert connection.getresponse().status == 200
    finally:
        connection.close()


def assert_404(origin, route):
    connection, response = https_request(origin, route)
    try:
        assert response.status == 404, "A private route was reachable through the public proxy"
    finally:
        connection.close()


def smoke(release, commit, caddy, report):
    manifest = verify(release, commit, "EPHEMERAL_CI_ONLY")
    host = manifest["game"]["host_agent_pub_key"]
    with tempfile.TemporaryDirectory(prefix="rc1-loopback-") as temp:
        root = Path(temp)
        cert, key = root / "tls.pem", root / "tls.key"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=" + FRONT, "-addext", "subjectAltName=DNS:" + FRONT + ",DNS:" + GATE,
            "-keyout", str(key), "-out", str(cert),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        front_port, gateway_port = free_port(), free_port()
        while gateway_port == front_port:
            gateway_port = free_port()
        public, paths = configuration({
            "frontend_origin": f"https://{FRONT}:{front_port}",
            "gateway_origin": f"https://{GATE}:{gateway_port}",
            "bootstrap_url": "https://bootstrap.example.test",
            "relay_url": "https://relay.example.test",
        }, {
            "static_root": str(root / "site"),
            "admin_secret_file": str(root / "gateway-admin"),
            "gateway_identity_file": str(root / "gateway-identity"),
            "gateway_session_db": str(root / "admission.sqlite"),
            "native_authority_root": str(root / "native"),
        })
        secret_path = paths["admin_secret_file"]
        fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as secret:
            secret.write(secrets.token_hex(32))
        site = paths["static_root"]
        activate_site(site, {name: (release / "frontend" / name).read_bytes() for name in SETUP})
        original = activate_site(site, release_files(release, public))
        updated = root / "changed"
        shutil.copytree(release / "frontend", updated / "frontend")
        setup = updated / "frontend/browser-setup.js"
        setup.write_bytes(setup.read_bytes() + b"\n// Loopback-only static change for rollback verification.\n")
        # The real gateway may use the existing test infrastructure in CI.
        # The deployment CLI still rejects these test endpoints.
        test_endpoint = "https://dev-test-bootstrap2.holochain.org/"
        env = gateway_environment({**public, "bootstrap_url": test_endpoint, "relay_url": test_endpoint}, paths)
        env["RUST_LOG"] = "warn"
        gateway = [str(release / GATEWAY), "--address", "127.0.0.1", "--port", "8090"]

        config = root / "Caddyfile"
        text = proxy_config(public, paths).replace(" {\n", f" {{\n    bind 127.0.0.1\n    tls {cert} {key}\n", 1)
        gateway_site = public["gateway_origin"] + " {\n"
        text = text.replace(gateway_site, gateway_site + f"    bind 127.0.0.1\n    tls {cert} {key}\n")
        config.write_text("{\n    admin off\n    auto_https disable_redirects\n}\n\n" + text)
        proxy_env = {**os.environ, "XDG_DATA_HOME": str(root / "caddy-data"),
                     "XDG_CONFIG_HOME": str(root / "caddy-config")}

        resolve = socket.getaddrinfo

        def loopback(hostname, *args, **kwargs):
            return resolve("127.0.0.1" if hostname in (FRONT, GATE) else hostname, *args, **kwargs)

        db = paths["gateway_session_db"]
        with service([str(caddy), "run", "--config", str(config), "--adapter", "caddyfile"],
                     front_port, root, proxy_env), patch("socket.getaddrinfo", side_effect=loopback), \
                patch.dict(os.environ, {"SSL_CERT_FILE": str(cert)}):
            with service(gateway, 8090, root, env):
                local_gateway_health()
                remote_preflight(public, release)
                change_admission("POST", host, "host", host, secret_path)
                assert admission_status(db, host) == {"allowed": True, "active_sessions": 0}
                identity_before = digest(paths["gateway_identity_file"])
                candidate = activate_site(site, release_files(updated, public))
                assert candidate != original
                remote_preflight(public, updated)
                assert activate_site(site, release_files(release, public), rollback=True) == original
                remote_preflight(public, release)
                assert_404(public["frontend_origin"], "/.binding.json")
                assert_404(public["frontend_origin"], f"/releases/{candidate}/browser-setup.js")
            with service(gateway, 8090, root, env):
                remote_preflight(public, release)
                assert digest(paths["gateway_identity_file"]) == identity_before
                assert admission_status(db, host) == {"allowed": True, "active_sessions": 0}
                change_admission("DELETE", host, None, host, secret_path)
                assert admission_status(db, host) == {"allowed": False, "active_sessions": 0}
            with service(gateway, 8090, root, env):
                local_gateway_health()
                assert admission_status(db, host) == {"allowed": False, "active_sessions": 0}

    report.write_text(json.dumps({
        "https_wss_loopback_preflight": "PASS",
        "static_rollback_over_https": "PASS",
        "persistent_gateway_identity_and_sqlite_admission": "PASS",
        "public_admin_and_internal_file_isolation": "PASS",
        "external_round_acceptance": "NOT EXECUTED",
    }, indent=2) + "\n")
    print("Operator loopback TLS, rollback and gateway restart checks PASS")


if __name__ == "__main__":
    release, commit, caddy, report = sys.argv[1:]
    smoke(Path(release).resolve(), commit, Path(caddy).resolve(), Path(report))
