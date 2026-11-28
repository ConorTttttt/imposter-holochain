#!/usr/bin/env python3
"""Run the mixed-browser harness against a disposable fixture or an operator release."""
import argparse
from base64 import b64encode
from contextlib import ExitStack, contextmanager, redirect_stdout
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
from shutil import copyfile, which
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
                    preflight_frontend, preflight_gateway, proxy_config, release_files, remote_preflight)
from package import EXTENSION, GATEWAY, PINS, SETUP, archive_extension, digest, verify
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
    native_log = state.parent / "native-local.log"
    env = {**os.environ, "RUST_LOG": "holochain=info,kitsune2=debug,iroh=warn"}
    with native_log.open("ab") as stream:
        child = subprocess.Popen(command, cwd=game, stdin=subprocess.PIPE,
                                 stdout=stream, stderr=stream, env=env, text=True, start_new_session=True)
        try:
            child.stdin.write(password + "\n")
            child.stdin.close()
            check = native_args("wait-native", release, state)
            run_checked(check, "TWO_EXACT_NATIVE_AUTHORITIES", log, cwd=game)
            gate("NATIVE_AUTHORITY_PROCESS", child.poll() is None)
            print("TWO_EXACT_NATIVE_AUTHORITIES=PASS", flush=True)
            # The pinned Kitsune2 starts with an empty current arc. The
            # existing native integration waits for both full-arc transitions
            # before accepting any HWC publication.
            deadline = time.monotonic() + 150
            while child.poll() is None and time.monotonic() < deadline:
                if native_log.read_text(errors="replace").count("Updating storage arc to full") >= 2:
                    break
                time.sleep(1)
            else:
                raise GateError("NATIVE_FULL_DHT_ARCS")
            print("NATIVE_FULL_DHT_ARCS=PASS", flush=True)
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
    env = None
    if config["mode"] == "operator":
        env = {key: value for key, value in os.environ.items() if not key.startswith("H2HC_LINKER_")}
    result = subprocess.run(["node", str(HERE / "mixed-browser.mjs"), command,
                             str(config_path), str(report)], cwd=ROOT, env=env)
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
    profiles = [scratch / name for name in ("host", "chromium-guest-a", "chromium-guest-b", "firefox-guest")]
    for profile in profiles:
        profile.mkdir(mode=0o700)
    cert, key, authority, spki = browser_fixture_tls(scratch, profiles[3], log)
    front_port, gateway_port = free_port(), free_port()
    while gateway_port == front_port:
        gateway_port = free_port()
    movement_port = free_port()
    while movement_port in (front_port, gateway_port, 8090, 33555, 33557):
        movement_port = free_port()
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
                         proxy_config(public, paths, movement_port).replace(" {\n    header", f" {{\n    tls {cert} {key}\n    bind 127.0.0.1\n    header", 1)
                         .replace(gateway + " {\n", f"{gateway} {{\n    tls {cert} {key}\n    bind 127.0.0.1\n"))
    caddy_env = {**os.environ, "XDG_DATA_HOME": str(scratch / "caddy-data"),
                 "XDG_CONFIG_HOME": str(scratch / "caddy-config")}
    host_file = scratch / "host.pub"
    config = {
        "mode": "fixture", "frontend": front, "gateway": gateway, "fixtureSpki": spki,
        "fixtureSecret": str(paths["admin_secret_file"]), "hostFile": str(host_file),
        "fixtureAdmissionDb": str(paths["gateway_session_db"]),
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
        gateway_env = {**gateway_environment(public, paths), "RUST_LOG": "warn,h2hc_linker::routes::publish=info"}
        with service([str(release / GATEWAY), "--address", "127.0.0.1", "--port", "8090"],
                     8090, scratch, gateway_env), patch.dict(os.environ, {"SSL_CERT_FILE": str(authority)}):
            with log.open("a") as stream, redirect_stdout(stream):
                remote_preflight(public, release)
            with authorities(args.game, release, scratch / "native", log):
                with service(["node", str(release / "backend/movement-relay.mjs"), front, str(movement_port),
                              "33555", str(paths["gateway_session_db"])], movement_port, scratch, {**os.environ, "IMPOSTER_FIXTURE_AUDIT": "1"}):
                    try:
                        launch("round", config_with_release(config, manifest), scratch, args.report)
                    finally:
                        counts = {}
                        for line in (scratch / f"{movement_port}.local.log").read_text().splitlines():
                            if re.fullmatch(r"RELAY_[A-Z_]+", line):
                                counts[line] = counts.get(line, 0) + 1
                        print("Relay stages", counts, flush=True)
        if args.candidate:
            from shutil import copytree
            copytree(release, args.candidate)


def check_operator_origin(origin, check):
    try:
        # Standard PKI and network reachability. This positively verifies HTTPS
        # and WSS, but says nothing about admission or encrypted receipt.
        check()
    except ssl.SSLError as error:
        raise GateError(f"OPERATOR_{origin}_TLS_TRUST_OR_CERTIFICATE") from error
    except OSError as error:
        cli = which("tailscale")
        if cli:
            try:
                status = subprocess.run([cli, "status", "--json"], capture_output=True,
                                        timeout=5, check=False, text=True)
                state = json.loads(status.stdout)
                if isinstance(state, dict) and state.get("BackendState") in {
                    "Stopped", "NeedsLogin", "NeedsMachineAuth",
                }:
                    raise GateError("OPERATOR_TAILSCALE_OFFLINE") from error
            except (OSError, ValueError, subprocess.SubprocessError):
                pass
        raise GateError(f"OPERATOR_{origin}_UNREACHABLE") from error
    except (ValueError, KeyError, http.client.HTTPException) as error:
        raise GateError(f"OPERATOR_{origin}_RESPONSE_MISMATCH") from error


def verify_chromium_tree(chrome, release_archive):
    # The release ZIP and its manifest were already verified. ZIP container
    # bytes can vary across zlib versions on the runner.
    gate("CHROMIUM_EXTENSION_NOT_EXACT_RELEASE", chrome.is_dir())
    with ZipFile(release_archive) as archive:
        expected = set(archive.namelist())
        actual = set()
        for path in chrome.rglob("*"):
            gate("CHROMIUM_EXTENSION_NOT_EXACT_RELEASE", not path.is_symlink())
            if path.is_dir():
                continue
            gate("CHROMIUM_EXTENSION_NOT_EXACT_RELEASE", path.is_file())
            if path.suffix != ".map":
                name = path.relative_to(chrome).as_posix()
                gate("CHROMIUM_EXTENSION_NOT_EXACT_RELEASE",
                     name in expected and path.read_bytes() == archive.read(name))
                actual.add(name)
        gate("CHROMIUM_EXTENSION_NOT_EXACT_RELEASE", actual == expected)


def stage_firefox(package, checksum, scratch):
    # Snapshot the verified bytes so the verifier and extractor use the same
    # archive. The combined CI download also has a Chromium checksum line.
    staged = scratch / "firefox-package"
    staged.mkdir()
    archive_path = staged / "firefox-desktop-hwc.zip"
    try:
        copyfile(package / archive_path.name, archive_path)
    except OSError as error:
        raise GateError("FIREFOX_EXTENSION_MISSING") from error
    gate("FIREFOX_EXTENSION_CHECKSUM", digest(archive_path) == checksum)
    (staged / "SHA256SUMS").write_text(f"{checksum}  {archive_path.name}\n")
    run_checked([sys.executable, str(RELEASE / "package-firefox.py"), "verify", str(staged)],
                "FIREFOX_EXTENSION_VERIFICATION", scratch / "verification.log")
    firefox = scratch / "firefox"
    with ZipFile(archive_path) as archive:
        archive.extractall(firefox)
    return firefox


@contextmanager
def lock_profiles(profiles):
    with ExitStack() as locks:
        for profile in sorted(profiles):
            fd = os.open(profile, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            locks.callback(os.close, fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise GateError("OPERATOR_PROFILE_IN_USE") from error
        # Chromium owns this sentinel, including when it is a dangling symlink.
        gate("OPERATOR_PROFILE_IN_USE",
             not any(os.path.lexists(profile / "SingletonLock") for profile in profiles[:-1]))
        yield


def operator(args, scratch, report, verified):
    def passed(stage):
        verified[stage] = "PASS"
        print(f"{stage}=PASS", flush=True)

    try:
        gate("OPERATOR_CONFIGURATION_MISSING", private(args.config))
        data = json.loads(args.config.read_text())
        public = {key: endpoint(data["public"][key], origin=True)
                  for key in ("frontend_origin", "gateway_origin")}
        gate("OPERATOR_CONFIGURATION_MISSING", len(set(public.values())) == 2)
        admission_db = Path(data["admission_database"]).resolve()
        release = Path(data["release"])
        commit, checksum = data["release_commit"], data["release_manifest_sha256"]
        profiles = [Path(path).resolve() for path in data["profiles"]]
        chrome = Path(data["chromium_extension"]).resolve()
        firefox_package = Path(data["firefox_package"])
        firefox_checksum = data["firefox_sha256"]
        hwc = Path(data["hwc_checkout"]).resolve()
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise GateError("OPERATOR_CONFIGURATION_MISSING") from error
    gate("OPERATOR_RELEASE_PROVENANCE_REQUIRED",
         isinstance(commit, str) and re.fullmatch(r"[0-9a-f]{40}", commit)
         and isinstance(checksum, str) and re.fullmatch(r"[0-9a-f]{64}", checksum))
    try:
        manifest = verify(release, commit, manifest_sha256=checksum)
    except (OSError, ValueError, KeyError, BadZipFile) as error:
        raise GateError("OPERATOR_RELEASE_VERIFICATION") from error
    passed("OPERATOR_RELEASE_PROVENANCE")
    check_operator_origin("FRONTEND", lambda: preflight_frontend(public, release))
    passed("OPERATOR_FRONTEND_EXACT_RELEASE")
    check_operator_origin("GATEWAY", lambda: preflight_gateway(public))
    passed("OPERATOR_GATEWAY_HTTPS_WSS_ISOLATION")
    gate("OPERATOR_PROFILE_CREDENTIALS_MISSING", len(profiles) == 4 and len(set(profiles)) == 4
         and all(private(path, directory=True) and any(path.iterdir()) for path in profiles)
         and not any(a.is_relative_to(b) for a in profiles for b in profiles if a != b))
    gate("OPERATOR_ADMISSION_STATE_UNAVAILABLE", private(admission_db))
    gate("FIREFOX_EXTENSION_CHECKSUM",
         isinstance(firefox_checksum, str) and re.fullmatch(r"[0-9a-f]{64}", firefox_checksum))
    verify_chromium_tree(chrome, release / EXTENSION)
    gate("FIREFOX_EXTENSION_CHECKSUM", firefox_checksum == manifest["artifacts"]["firefox-desktop-hwc.zip"])
    firefox = stage_firefox(firefox_package, firefox_checksum, scratch)
    passed("OPERATOR_EXTENSION_PROVENANCE")
    try:
        node = subprocess.check_output(["node", "--version"], text=True, stderr=subprocess.DEVNULL).strip()
        hwc_head = subprocess.check_output(["git", "-C", hwc, "rev-parse", "--verify", "HEAD"],
                                           text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.SubprocessError) as error:
        raise GateError("OPERATOR_RUNNER_TOOLCHAIN") from error
    gate("OPERATOR_RUNNER_TOOLCHAIN", node == PINS["node_version"] and hwc_head == PINS["hwc_commit"])
    passed("OPERATOR_RUNNER_TOOLCHAIN")
    config = {
        "mode": "operator", "frontend": public["frontend_origin"], "gateway": public["gateway_origin"],
        "admissionDb": str(admission_db), "profiles": list(map(str, profiles)),
        "hwc": str(hwc), "chromiumExtension": str(chrome),
        "firefoxExtension": str(firefox),
    }
    with lock_profiles(profiles):
        launch("round" if args.round else "preflight", config_with_release(config, manifest), scratch, report)


def run_operator(args):
    # Exclusive create also refuses a dangling symlink or concurrent run
    # using the same destination. Browser logs never open this path.
    try:
        evidence = args.report.open("x")
    except OSError:
        raise SystemExit("OPERATOR_EVIDENCE_PATH_UNAVAILABLE=FAIL") from None
    with evidence, tempfile.TemporaryDirectory(prefix="imposter-operator-") as folder:
        scratch = Path(folder)
        stage_report = scratch / "browser-evidence.json"
        verified = {}
        outcome = {"suite": "mixed-desktop", "mode": "operator", "status": "INCOMPLETE"}
        evidence.write(json.dumps(outcome) + "\n")
        evidence.flush()
        failure = None
        try:
            operator(args, scratch, stage_report, verified)
        except GateError as error:
            failure = str(error)
        except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError, RuntimeError):
            failure = "OPERATOR_RUNNER_OR_RELEASE_SETUP"
        if stage_report.is_file():
            try:
                child = json.loads(stage_report.read_text())
                outcome["status"] = child["status"]
                verified.update({key: "PASS" for key, value in child["stages"].items()
                                 if re.fullmatch(r"[A-Z0-9_]+", key) and value == "PASS"})
                code = child.get("failure")
                if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_]+", code):
                    outcome["failure"] = code
            except (OSError, TypeError, ValueError, KeyError, AttributeError):
                failure = "OPERATOR_BROWSER_EVIDENCE_INVALID"
        expected = "ROUND_VERIFIED" if args.round else "PREFLIGHT_VERIFIED"
        if failure or outcome["status"] != expected:
            outcome.setdefault("failure", failure or "OPERATOR_BROWSER_EVIDENCE_MISSING")
            outcome["status"] = "FAILED"
        outcome["stages"] = verified
        evidence.seek(0)
        evidence.write(json.dumps(outcome, indent=2) + "\n")
        evidence.truncate()
    if outcome["status"] == "FAILED":
        raise SystemExit(outcome["failure"] + "=FAIL")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    cloud = sub.add_parser("fixture")
    for field in ("game", "hwc", "firefox", "gateway", "caddy", "report"):
        cloud.add_argument("--" + field, type=lambda path: Path(path).resolve(), required=True)
    live = sub.add_parser("operator")
    cloud.add_argument("--candidate", type=Path)
    live.add_argument("--config", type=Path, required=True)
    live.add_argument("--report", type=Path, required=True)
    live.add_argument("--round", action="store_true")
    tool = sub.add_parser("native")
    tool.add_argument("operation", choices=["init-native", "run-native", "wait-native"])
    tool.add_argument("release", type=Path)
    tool.add_argument("state", type=Path)
    args = parser.parse_args()
    if args.mode == "native":
        native(args.operation, args.release, args.state)
        return
    os.umask(0o077)
    if args.mode == "operator":
        run_operator(args)
        return
    if args.report.exists():
        raise SystemExit("Use a new evidence path")
    try:
        with tempfile.TemporaryDirectory(prefix="imposter-mixed-") as folder:
            fixture(args, Path(folder))
    except GateError as error:
        report_failure(args.report, args.mode, str(error))
        raise SystemExit(1) from None
    except (OSError, ValueError, KeyError, TypeError, BadZipFile, subprocess.SubprocessError, RuntimeError):
        report_failure(args.report, args.mode, "RUNNER_OR_RELEASE_SETUP")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
