#!/usr/bin/env python3
"""Run the mixed-browser harness against a disposable fixture or an operator release."""
import argparse
from base64 import b64encode
from contextlib import contextmanager, redirect_stdout
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
from shutil import which
import signal
import ssl
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
from zipfile import BadZipFile, ZipFile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
RELEASE = ROOT / "release/browser-alpha"
sys.path.insert(0, str(RELEASE))
from deploy import (authority_cells, endpoint, gateway_environment, native_command,
                    proxy_config, release_files, remote_preflight)
from package import EXTENSION, GATEWAY, SETUP, archive_extension, digest, verify
from site_release import activate_site
from smoke import free_port, service

TEST_NETWORK = dict.fromkeys(
    ("bootstrap_url", "relay_url"), "https://dev-test-bootstrap2.holochain.org/"
)


class GateError(RuntimeError):
    """A stage code safe for the console and CI artifacts."""


def gate(code, condition):
    if not condition:
        raise GateError(code)


def report_failure(report, mode, code):
    if not report.exists():
        report.write_text(json.dumps({
            "suite": "mixed-desktop", "mode": mode, "status": "FAILED", "failure": code,
        }, indent=2) + "\n")
    print(f"{code}=FAIL", file=sys.stderr)


def private(path, directory=False):
    return (path.is_dir() if directory else path.is_file()) and not path.stat().st_mode & 0o077


def run_checked(command, stage, log, *, cwd=ROOT, env=None, input_text=None):
    with log.open("ab") as stream:
        result = subprocess.run(command, cwd=cwd, env=env, input=input_text,
                                text=True, stdout=stream, stderr=stream)
    gate(stage, result.returncode == 0)


def native_args(operation, release, state):
    return ["nix", "develop", "--no-write-lock-file", "--command", "python3",
            str(__file__), "native", operation, str(release), str(state)]


@contextmanager
def authorities(game, release, state, log):
    password = secrets.token_hex(32)
    init = native_args("init-native", release, state)
    run_checked(init, "NATIVE_AUTHORITY_INITIALIZATION", log, cwd=game, input_text=password + "\n")
    command = native_args("run-native", release, state)
    with log.open("ab") as stream:
        child = subprocess.Popen(command, cwd=game, stdin=subprocess.PIPE,
                                 stdout=stream, stderr=stream, text=True, start_new_session=True)
        try:
            child.stdin.write(password + "\n")
            child.stdin.close()
            check = native_args("wait-native", release, state)
            run_checked(check, "TWO_EXACT_NATIVE_AUTHORITIES", log, cwd=game)
            gate("NATIVE_AUTHORITY_PROCESS", child.poll() is None)
            print("TWO_EXACT_NATIVE_AUTHORITIES=PASS", flush=True)
            yield
        finally:
            try:
                os.killpg(child.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


def native(operation, release, state):
    if operation == "wait-native":
        expected = json.loads((release / "frontend/deployment.json").read_text())["dna_hash"]
        stop = time.monotonic() + 75
        while time.monotonic() < stop:
            try:
                authority_cells(expected)
                return
            except (ValueError, KeyError, subprocess.SubprocessError):
                time.sleep(0.75)
        raise GateError("TWO_EXACT_NATIVE_AUTHORITIES")
    with patch("deploy.getpass", return_value=sys.stdin.readline().strip()):
        native_command(operation, release, TEST_NETWORK, state)


def launch(command, config, scratch, report):
    config_path = scratch / "browser-input.json"
    config_path.write_text(json.dumps(config))
    result = subprocess.run(["node", str(HERE / "mixed-browser.mjs"), command,
                             str(config_path), str(report)], cwd=ROOT)
    gate("MIXED_BROWSER_RUNNER", result.returncode == 0)


def config_with_release(config, manifest):
    game = manifest["game"]
    return {**config, "host": game["host_agent_pub_key"], "seed": game["network_seed"],
            "dna": game["dna_hash"]}


def browser_fixture_tls(scratch, firefox, log):
    authority = scratch / "local-ca.crt"
    authority_key = scratch / "local-ca.key"
    cert = scratch / "local.crt"
    key = scratch / "local.key"
    request = scratch / "local.csr"
    extensions = scratch / "server.ext"
    extensions.write_text("basicConstraints=critical,CA:FALSE\n"
                          "keyUsage=critical,digitalSignature,keyEncipherment\n"
                          "extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n")
    run_checked([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=Imposter Local Fixture CA", "-addext", "basicConstraints=critical,CA:TRUE",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", str(authority_key),
        "-out", str(authority),
    ], "FIXTURE_TLS_CERTIFICATE", log)
    run_checked(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
                 "-keyout", str(key), "-out", str(request)], "FIXTURE_TLS_CERTIFICATE", log)
    run_checked(["openssl", "x509", "-req", "-in", str(request), "-CA", str(authority),
                 "-CAkey", str(authority_key), "-CAcreateserial", "-out", str(cert),
                 "-days", "1", "-extfile", str(extensions)], "FIXTURE_TLS_CERTIFICATE", log)
    for options in [["-N", "--empty-password"], ["-A", "-n", "Imposter fixture", "-t", "C,,", "-i", str(authority)]]:
        run_checked(["certutil", "-d", "sql:" + str(firefox), *options], "FIXTURE_FIREFOX_TLS_TRUST", log)
    pem = subprocess.check_output(["openssl", "x509", "-in", cert, "-pubkey", "-noout"])
    der = subprocess.run(["openssl", "pkey", "-pubin", "-outform", "der"],
                         input=pem, capture_output=True, check=True).stdout
    return cert, key, authority, b64encode(hashlib.sha256(der).digest()).decode()


def fixture(args, scratch):
    log = scratch / "fixture.log"
    profiles = [scratch / name for name in ("host", "chromium-guest", "firefox-guest")]
    for profile in profiles:
        profile.mkdir(mode=0o700)
    cert, key, authority, spki = browser_fixture_tls(scratch, profiles[2], log)
    front_port, gateway_port = free_port(), free_port()
    while gateway_port == front_port:
        gateway_port = free_port()
    front, gateway = (f"https://localhost:{port}" for port in (front_port, gateway_port))
    public = {**TEST_NETWORK, "frontend_origin": front, "gateway_origin": gateway}
    paths = {
        "static_root": scratch / "site", "admin_secret_file": scratch / "gateway-secret",
        "gateway_identity_file": scratch / "gateway-key", "gateway_session_db": scratch / "sessions.sqlite",
    }
    paths["admin_secret_file"].write_text(secrets.token_hex(32))
    paths["admin_secret_file"].chmod(0o600)
    activate_site(paths["static_root"], {name: (RELEASE / "frontend" / name).read_bytes() for name in SETUP})
    caddyfile = scratch / "Caddyfile"
    caddyfile.write_text("{\n    admin off\n    auto_https disable_redirects\n}\n" +
                         proxy_config(public, paths).replace(" {\n    header", f" {{\n    tls {cert} {key}\n    bind 127.0.0.1\n    header", 1)
                         .replace(gateway + " {\n", f"{gateway} {{\n    tls {cert} {key}\n    bind 127.0.0.1\n"))
    caddy_env = {**os.environ, "XDG_DATA_HOME": str(scratch / "caddy-data"),
                 "XDG_CONFIG_HOME": str(scratch / "caddy-config")}
    host_file = scratch / "host.pub"
    config = {
        "mode": "fixture", "frontend": front, "gateway": gateway, "fixtureSpki": spki,
        "fixtureSecret": str(paths["admin_secret_file"]), "hostFile": str(host_file),
        "profiles": list(map(str, profiles)), "hwc": str(args.hwc),
        "chromiumExtension": str(args.hwc / "packages/extension/dist-chrome"),
        "firefoxExtension": str(args.firefox / "packages/extension/dist-firefox"),
    }
    with service([str(args.caddy), "run", "--config", str(caddyfile), "--adapter", "caddyfile"],
                 front_port, scratch, caddy_env):
        launch("bootstrap", config, scratch, args.report)
        host = host_file.read_text().strip()
        seed = "g1." + host + "." + secrets.token_hex(16)
        release = scratch / "release"
        env = {**os.environ, "BROWSER_ALPHA_CI_PROFILE": "1"}
        run_checked(["bash", str(RELEASE / "build.sh"), str(args.game), str(args.hwc), host,
                     seed, str(args.gateway), str(release)], "EXACT_FIXTURE_RELEASE_BUILD", log, env=env)
        revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        manifest = verify(release, revision, "EPHEMERAL_CI_ONLY")
        archive = scratch / "chromium-runtime.zip"
        archive_extension(Path(config["chromiumExtension"]), archive)
        gate("EXACT_CHROMIUM_RELEASE_BUILD", digest(archive) == digest(release / EXTENSION))
        print("EXACT_FIXTURE_RELEASE_BUILD=PASS", flush=True)
        activate_site(paths["static_root"], release_files(release, public))
        gateway_env = {**gateway_environment(public, paths), "RUST_LOG": "warn"}
        with service([str(release / GATEWAY), "--address", "127.0.0.1", "--port", "8090"],
                     8090, scratch, gateway_env), patch.dict(os.environ, {"SSL_CERT_FILE": str(authority)}):
            with log.open("a") as stream, redirect_stdout(stream):
                remote_preflight(public, release)
            with authorities(args.game, release, scratch / "native", log):
                launch("round", config_with_release(config, manifest), scratch, args.report)


def check_operator_network(public, release):
    try:
        # Standard PKI and network reachability. This positively verifies HTTPS
        # and WSS, but says nothing about admission or encrypted receipt.
        remote_preflight(public, release)
    except ssl.SSLError as error:
        raise GateError("OPERATOR_TLS_TRUST_OR_CERTIFICATE") from error
    except OSError as error:
        cli = which("tailscale")
        if cli:
            try:
                status = subprocess.run([cli, "status", "--json"], capture_output=True,
                                        timeout=5, check=False, text=True)
                if json.loads(status.stdout).get("BackendState") in {"Stopped", "NeedsLogin", "NeedsMachineAuth"}:
                    raise GateError("OPERATOR_TAILSCALE_OFFLINE") from error
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        raise GateError("OPERATOR_NETWORK_OR_TAILSCALE_UNREACHABLE") from error
    except (ValueError, KeyError, http.client.HTTPException) as error:
        raise GateError("OPERATOR_SERVED_RELEASE_OR_GATEWAY_MISMATCH") from error


def operator(args, scratch):
    try:
        gate("OPERATOR_CONFIGURATION_MISSING", private(args.config))
        data = json.loads(args.config.read_text())
        public = {key: endpoint(data["public"][key], origin=True)
                  for key in ("frontend_origin", "gateway_origin")}
        gate("OPERATOR_CONFIGURATION_MISSING", len(set(public.values())) == 2)
        admission_db = Path(data["admission_database"]).resolve()
        release = Path(data["release"])
        commit, checksum = data["release_commit"], data["release_manifest_sha256"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise GateError("OPERATOR_CONFIGURATION_MISSING") from error
    gate("OPERATOR_RELEASE_PROVENANCE_REQUIRED", bool(commit and checksum))
    try:
        manifest = verify(release, commit, manifest_sha256=checksum)
    except (OSError, ValueError, KeyError, BadZipFile) as error:
        raise GateError("OPERATOR_RELEASE_VERIFICATION") from error
    check_operator_network(public, release)
    profiles = [Path(path).resolve() for path in data["profiles"]]
    gate("OPERATOR_PROFILE_CREDENTIALS_MISSING", len(profiles) == 3 and len(set(profiles)) == 3
         and all(private(path, directory=True) and any(path.iterdir()) for path in profiles))
    gate("OPERATOR_ADMISSION_STATE_UNAVAILABLE", private(admission_db))
    chrome = Path(data["chromium_extension"]).resolve()
    chrome_check = scratch / "chrome-check.zip"
    archive_extension(chrome, chrome_check)
    gate("CHROMIUM_EXTENSION_NOT_EXACT_RELEASE", digest(chrome_check) == digest(release / EXTENSION))
    firefox_archive = Path(data["firefox_package"]) / "firefox-desktop-hwc.zip"
    gate("FIREFOX_EXTENSION_CHECKSUM", digest(firefox_archive) == data["firefox_sha256"])
    run_checked([sys.executable, str(RELEASE / "package-firefox.py"), "verify",
                 str(firefox_archive.parent)], "FIREFOX_EXTENSION_VERIFICATION", scratch / "verification.log")
    firefox = scratch / "firefox"
    with ZipFile(firefox_archive) as archive:
        archive.extractall(firefox)
    config = {
        "mode": "operator", "frontend": public["frontend_origin"], "gateway": public["gateway_origin"],
        "admissionDb": str(admission_db), "profiles": list(map(str, profiles)),
        "hwc": str(Path(data["hwc_checkout"]).resolve()), "chromiumExtension": str(chrome),
        "firefoxExtension": str(firefox),
    }
    launch("round" if args.round else "preflight", config_with_release(config, manifest), scratch, args.report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    cloud = sub.add_parser("fixture")
    for field in ("game", "hwc", "firefox", "gateway", "caddy", "report"):
        cloud.add_argument("--" + field, type=lambda path: Path(path).resolve(), required=True)
    live = sub.add_parser("operator")
    live.add_argument("--config", type=Path, required=True)
    live.add_argument("--report", type=lambda path: Path(path).resolve(), required=True)
    live.add_argument("--round", action="store_true")
    tool = sub.add_parser("native")
    tool.add_argument("operation", choices=["init-native", "run-native", "wait-native"])
    tool.add_argument("release", type=Path)
    tool.add_argument("state", type=Path)
    args = parser.parse_args()
    if args.mode == "native":
        native(args.operation, args.release, args.state)
        return
    if args.report.exists():
        raise SystemExit("Use a new evidence path")
    os.umask(0o077)
    try:
        with tempfile.TemporaryDirectory(prefix="imposter-mixed-") as folder:
            (fixture if args.mode == "fixture" else operator)(args, Path(folder))
    except GateError as error:
        report_failure(args.report, args.mode, str(error))
        raise SystemExit(1) from None
    except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError, RuntimeError):
        report_failure(args.report, args.mode, "RUNNER_OR_RELEASE_SETUP")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
