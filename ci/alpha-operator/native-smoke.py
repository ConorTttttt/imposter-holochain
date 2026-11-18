#!/usr/bin/env python3
"""Run the operator Holochain 0.7 commands twice against the same verified native state."""
from contextlib import contextmanager, redirect_stdout
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "release/browser-alpha"))
from deploy import authority_cells, native_command
from package import verify

TEST_NETWORK = {
    "bootstrap_url": "https://dev-test-bootstrap2.holochain.org/",
    "relay_url": "https://dev-test-bootstrap2.holochain.org/",
}


@contextmanager
def authority_process(release, root, passphrase):
    # Output may contain Lair connection details. Keep it inside the temporary
    # directory for this test and publish only boolean acceptance results.
    with (root.parent / "authority-local.log").open("wb") as log:
        process = subprocess.Popen([sys.executable, __file__, "--child", str(release), str(root)],
                                   stdin=subprocess.PIPE, stdout=log, stderr=log,
                                   text=True, start_new_session=True)
        try:
            process.stdin.write(passphrase + "\n")
            process.stdin.close()
            yield process
        finally:
            try:
                os.killpg(process.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                process.wait(15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            # The wrapper may exit before hc finishes shutting down.
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if all(port_closed(port) for port in (33555, 33557)):
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError("Native authority admin ports did not close")


def port_closed(port):
    with socket.socket() as client:
        client.settimeout(1)
        return client.connect_ex(("127.0.0.1", port)) != 0


def ready(process, dna):
    stop = time.monotonic() + 75
    while time.monotonic() < stop and process.poll() is None:
        try:
            return authority_cells(dna)
        except (ValueError, KeyError, subprocess.SubprocessError):
            time.sleep(0.5)
    raise RuntimeError("Two native authorities did not report the expected DNA")


def smoke(release, commit, report):
    verified = verify(release, commit, "EPHEMERAL_CI_ONLY")
    dna = verified["game"]["dna_hash"]
    with tempfile.TemporaryDirectory(prefix="rc1-native-") as temp:
        logs = Path(temp)
        root = logs / "authorities"
        passphrase = secrets.token_hex(32)
        with (logs / "generate-local.log").open("w") as log, redirect_stdout(log), \
                patch("deploy.getpass", return_value=passphrase):
            # hc writes to subprocess stdout by default. Redirect that file
            # descriptor too so raw sandbox output stays out of CI logs.
            original = os.dup(1)
            original_error = os.dup(2)
            try:
                os.dup2(log.fileno(), 1)
                os.dup2(log.fileno(), 2)
                native_command("init-native", release, TEST_NETWORK, root)
            finally:
                os.dup2(original, 1)
                os.dup2(original_error, 2)
                os.close(original)
                os.close(original_error)
        with authority_process(release, root, passphrase) as first:
            identities = ready(first, dna)
        with authority_process(release, root, passphrase) as second:
            assert ready(second, dna) == identities, "Authority identities changed across restart"

    report.write_text(json.dumps({
        "native_init_and_restart": "PASS", "authority_count": 2,
        "same_native_identities": True, "exact_installed_dna": dna,
        "external_round_acceptance": "NOT EXECUTED",
    }, indent=2) + "\n")
    print("Exact native DNA and both persistent authority identities verified across restart")


if __name__ == "__main__":
    if sys.argv[1] == "--child":
        with patch("deploy.getpass", return_value=sys.stdin.readline().strip()):
            native_command("run-native", Path(sys.argv[2]), TEST_NETWORK, Path(sys.argv[3]))
    else:
        smoke(Path(sys.argv[1]).resolve(), sys.argv[2], Path(sys.argv[3]))
