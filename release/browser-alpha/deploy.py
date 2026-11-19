#!/usr/bin/env python3
"""Validate operator settings and prepare the HTTPS/WSS browser alpha."""
from argparse import ArgumentParser
from base64 import b64encode
from getpass import getpass
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
from urllib.parse import urlsplit
from zipfile import BadZipFile

from package import GATEWAY, HAPP, HERE, SETUP, ValidationError, digest, load, require, sha256_stream, verify
from site_release import FRONTEND, activate_site

PUBLIC = {"frontend_origin", "gateway_origin", "bootstrap_url", "relay_url"}
PRIVATE = {"static_root", "gateway_identity_file", "gateway_session_db",
           "admin_secret_file", "native_authority_root"}
CI_BOOTSTRAP = "dev-test-bootstrap2.holochain.org"


def endpoint(value, *, origin=False):
    require(isinstance(value, str) and re.fullmatch(r"[\x21-\x7e]+", value)
            and not any(c in value for c in "\\?%#"), "Expected a clean HTTPS URL")
    url = urlsplit(value)
    host = url.hostname
    require(url.scheme == "https" and host and not url.username and url.password is None
            and not url.query and not url.fragment and (not origin or url.path == ""),
            "Expected an HTTPS URL without userinfo, query or fragment")
    require(url.port is None or url.port > 0, "Invalid HTTPS port")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        require(re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host) and not host.endswith(".localhost")
                and all(not part.startswith("-") and not part.endswith("-") for part in host.split("."))
                and host != CI_BOOTSTRAP, "Expected an operator HTTPS hostname")
    else:
        require(not address.is_loopback and not address.is_unspecified and not address.is_link_local,
                "Loopback, unspecified and link-local HTTPS endpoints are outside this deployment recipe")
    authority = f"[{host}]" if ":" in host else host
    if url.port not in (None, 443):
        authority += f":{url.port}"
    require(value == f"https://{authority}{url.path}", "Expected a canonical HTTPS URL")
    return value


def configuration(public, private):
    require(set(public) == PUBLIC and set(private) == PRIVATE, "Configuration fields differ from the templates")
    clean = {name: endpoint(value, origin=name.endswith("_origin")) for name, value in public.items()}
    require(clean["frontend_origin"] != clean["gateway_origin"], "Use distinct frontend and gateway origins")
    paths = {}
    for name, value in private.items():
        require(isinstance(value, str) and re.fullmatch(r"/[A-Za-z0-9_./-]+", value),
                "Operator paths must be absolute local paths without shell metacharacters")
        p = Path(value)
        require(str(p) == value and ".." not in p.parts and p != Path("/"),
                "Use canonical non-root operator paths")
        resolved = p.resolve()
        require(re.fullmatch(r"/[A-Za-z0-9_./-]+", str(resolved)), "Resolved operator path contains unsupported characters")
        paths[name] = resolved
    static = paths["static_root"]
    for name, path in paths.items():
        if name != "static_root":
            require(not path.is_relative_to(static) and not static.is_relative_to(path),
                    "Keep backend directories and secret files separate from the static root")
    require(len(set(paths.values())) == len(paths), "Operator paths must be distinct")
    return clean, paths


def browser_config(public):
    return {key: public[key] for key in ("frontend_origin", "gateway_origin")}


def proxy_config(public, paths, movement_port=None):
    routes = " ".join("/" + file for file in sorted(FRONTEND))
    movement = ""
    if movement_port is not None:
        require(type(movement_port) is int and 1 <= movement_port <= 65535 and movement_port != 8090,
                "Use a separate local port for the browser movement relay")
        movement = f"""
    handle /gameplay-movement {{
        reverse_proxy 127.0.0.1:{movement_port}
    }}"""
    return f"""{public['frontend_origin']} {{
    header X-Content-Type-Options nosniff
    redir / /browser-setup.html 302{movement}
    @alpha path {routes}
    handle @alpha {{
        header Cache-Control "no-store"
        root * "{paths['static_root'] / 'current'}"
        file_server
    }}
    handle {{
        respond 404
    }}
}}

{public['gateway_origin']} {{
    @admin path /admin /admin/*
    respond @admin 404
    reverse_proxy 127.0.0.1:8090
}}
"""


def release_files(release, public):
    files = {name: (release / "frontend" / name).read_bytes() for name in FRONTEND - {"browser-config.json"}}
    files["browser-config.json"] = (json.dumps(browser_config(public), sort_keys=True) + "\n").encode()
    return files


def verify_private_config_location(static, *files):
    require(all(not path.resolve().is_relative_to(static) for path in files),
            "Store operator and deployment input files outside the served directory")


def admin_secret(path):
    with open(path, "r", opener=lambda name, flags: os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK)) as stream:
        mode = os.fstat(stream.fileno()).st_mode
        require(stat.S_ISREG(mode) and not mode & 0o077, "Restrict the gateway secret file to its owner")
        value = stream.read().strip()
    require(re.fullmatch(r"[0-9a-f]{64}", value), "Expected a 32-byte hex gateway admin secret")
    return value


def gateway_environment(public, paths):
    secret = admin_secret(paths["admin_secret_file"])
    for key in ("gateway_identity_file", "gateway_session_db"):
        require(paths[key].parent.is_dir(), "Create the protected gateway state directory first")
    env = {k: v for k, v in os.environ.items() if not k.startswith("H2HC_LINKER_")}
    env.update(
        H2HC_LINKER_ADDRESS="127.0.0.1", H2HC_LINKER_PORT="8090",
        H2HC_LINKER_KEY_FILE=str(paths["gateway_identity_file"]),
        H2HC_LINKER_SESSION_STORE="sqlite://" + str(paths["gateway_session_db"]),
        H2HC_LINKER_ADMIN_SECRET=secret,
        H2HC_LINKER_BOOTSTRAP_URL=public["bootstrap_url"], H2HC_LINKER_RELAY_URL=public["relay_url"],
        H2HC_LINKER_ALLOW_INSECURE_DEV="false", H2HC_LINKER_LOCAL_AUTHORITY_FALLBACK="false",
    )
    return env


def run_gateway(root, public, paths):
    env = gateway_environment(public, paths)
    os.umask(0o077)
    exe = str((root / GATEWAY).resolve())
    os.execve(exe, [exe, "--address", "127.0.0.1", "--port", "8090"], env)


def check_agent(agent):
    require(re.fullmatch(r"uhCAk[A-Za-z0-9_-]{48}", agent), "Expected a public HWC agent key")


def admission_status(path, agent):
    check_agent(agent)
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5) as db:
        allowed, sessions = db.execute("""
            select exists(select 1 from allowed_agents where agent_pubkey = ?),
                   (select count(*) from sessions where agent_pubkey = ?)
        """, (agent, agent)).fetchone()
    return {"allowed": bool(allowed), "active_sessions": sessions}


def change_admission(method, agent, role, host, secret_file):
    check_agent(agent)
    body = {"agent_pubkey": agent}
    if method == "POST":
        require((role == "host") == (agent == host), "Host admission differs from the host-bound hApp")
        body["capabilities"] = ["dht_read", "dht_write", "k2",
                                "game_role_deliver" if role == "host" else "game_role_request"]
    connection = http.client.HTTPConnection("127.0.0.1", 8090, timeout=10)
    try:
        connection.request(method, "/admin/agents", json.dumps(body), {
            "Authorization": "Bearer " + admin_secret(secret_file), "Content-Type": "application/json",
        })
        require(connection.getresponse().status == 204, "Loopback gateway rejected the admission change")
    finally:
        connection.close()


def verify_native_cli():
    hc_version = subprocess.check_output(["hc", "--version"], text=True)
    require(re.search(r"\b0\.7\.0\b", hc_version), "Run native commands inside the pinned Holochain 0.7.0 Nix shell")


def authority_cells(dna):
    verify_native_cli()
    agents = []
    for port in (33555, 33557):
        cells = json.loads(subprocess.check_output(
            ["hc", "client", "call", "--port", str(port), "list-cells"], text=True, timeout=20
        ))
        require(len(cells) == 1 and cells[0]["dna_hash"] == dna,
                f"Native authority on port {port} does not have exactly the expected installed DNA")
        agents.append(cells[0]["agent_pub_key"])
    require(len(set(agents)) == 2, "Expected two distinct native authority identities")
    return tuple(agents)


def native_command(operation, release, public, root):
    verify_native_cli()
    binding = root / ".imposter-authority.json"
    config = {
        "happ_sha256": digest(release / HAPP),
        "bootstrap_url": public["bootstrap_url"],
        "relay_url": public["relay_url"],
    }
    if operation == "init-native":
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not any(root.iterdir()), "Native authority state already exists")
        args = ["generate", "--app-id", "imposter-native-authority", "--num-sandboxes", "2",
                "--root", str(root), "--directories", "conductor-a,conductor-b", "--in-process-lair",
                str((release / HAPP).resolve()), "network", "--bootstrap", public["bootstrap_url"],
                "--target-arc-factor", "1", "quic", public["relay_url"]]
    else:
        require((root / ".hc").is_file(), "Initialize the two native authorities first")
        require(binding.is_file() and not binding.is_symlink() and load(binding) == config,
                "Native authorities were initialized for different release bytes or endpoints")
        # Holochain persists app interfaces. Attaching the same ports on
        # every restart can fail and the authorities only need private admin.
        args = ["--force-admin-ports", "33555,33557", "run", "--all"]
    password = getpass("Native authority Lair passphrase: ")
    require(bool(password), "Native authority passphrase is required")
    env = {key: value for key, value in os.environ.items() if not key.startswith("H2HC_LINKER_")}
    os.umask(0o077)
    subprocess.run(["hc", "sandbox", "--piped", *args], cwd=root, env=env,
                   input=password + "\n", text=True, check=True)
    if operation == "init-native":
        require((root / ".hc").is_file(), "Native initialization did not create sandbox state")
        with binding.open("x") as target:
            json.dump(config, target, sort_keys=True)
            target.write("\n")


def https_request(origin, path, headers=None):
    url = urlsplit(origin)
    connection = http.client.HTTPSConnection(url.hostname, url.port or 443, timeout=10)
    try:
        connection.request("GET", path, headers=headers or {})
        return connection, connection.getresponse()
    except (OSError, http.client.HTTPException):
        connection.close()
        raise


def preflight_frontend(public, release):
    front = public["frontend_origin"]
    for path in ("/browser-setup.html", "/browser-setup.js", "/browser-demo.html", "/deployment.json",
                 "/" + Path(HAPP).name, "/browser-config.json"):
        connection, response = https_request(front, path)
        try:
            require(response.status == 200, f"Frontend HTTPS preflight failed for {path}")
            if path == "/browser-config.json":
                require(json.load(response) == browser_config(public), "Served browser settings differ")
            else:
                require(sha256_stream(response) == digest(release / "frontend" / path[1:]),
                        f"Served release bytes differ for {path}")
        finally:
            connection.close()


def preflight_gateway(public):
    front, gateway = public["frontend_origin"], public["gateway_origin"]
    for path, expected in (("/health", 200), ("/admin/agents", 404)):
        connection, response = https_request(gateway, path)
        try:
            require(response.status == expected, "Gateway health or public admin isolation check failed")
        finally:
            connection.close()
    nonce = b64encode(os.urandom(16)).decode()
    accept = b64encode(hashlib.sha1((nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
    connection, response = https_request(gateway, "/ws", {
        "Upgrade": "websocket", "Connection": "Upgrade", "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": nonce, "Origin": front,
    })
    try:
        require(response.status == 101 and response.getheader("Sec-WebSocket-Accept") == accept,
                "Gateway WSS upgrade failed")
    finally:
        connection.close()


def remote_preflight(public, release):
    preflight_frontend(public, release)
    preflight_gateway(public)
    print("HTTPS assets, gateway health, admin isolation and WSS upgrade PASS")
    print("External three-player acceptance NOT EXECUTED")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["check", "render-proxy", "bootstrap-site", "publish", "rollback",
                                              "preflight", "gateway", "admit", "revoke", "admission-status",
                                              "init-native", "run-native", "native-status"])
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--operator", type=Path, required=True)
    parser.add_argument("--release", type=Path)
    parser.add_argument("--release-commit")
    parser.add_argument("--manifest-sha256", help="Independently recorded release manifest checksum")
    parser.add_argument("--movement-port", type=int, help="Enable the optional local gameplay movement relay in render-proxy")
    parser.add_argument("--agent")
    parser.add_argument("--role", choices=["host", "guest"])
    args = parser.parse_args()
    try:
        public, paths = configuration(load(args.public), load(args.operator))
        root = paths["static_root"]
        verify_private_config_location(root, args.public, args.operator)
        if args.operation == "check":
            print("Strict URL and filesystem separation checks PASS")
            return
        if args.operation == "render-proxy":
            print(proxy_config(public, paths, args.movement_port), end="")
            return
        if args.operation == "bootstrap-site":
            version = activate_site(root, {name: (HERE / "frontend" / name).read_bytes() for name in SETUP})
            print(f"Bootstrap snapshot active {version}")
            return
        require(args.release and args.release_commit, "This operation requires a verified release and source commit")
        release = args.release.resolve()
        require(not release.is_relative_to(root) and not root.is_relative_to(release),
                "Serve the dedicated static root rather than the distribution directory")
        manifest = verify(release, args.release_commit, manifest_sha256=args.manifest_sha256)
        if args.operation in ("publish", "rollback"):
            version = activate_site(root, release_files(release, public), rollback=args.operation == "rollback")
            print(f"Static release snapshot active {version}")
        if args.operation == "preflight":
            remote_preflight(public, release)
        if args.operation == "gateway":
            run_gateway(release, public, paths)
        if args.operation in ("init-native", "run-native"):
            native_command(args.operation, release, public, paths["native_authority_root"])
        if args.operation == "native-status":
            dna = manifest["game"]["dna_hash"]
            authority_cells(dna)
            print(f"Two separate local native authorities reported installed DNA {dna}")
        if args.operation in ("admit", "revoke"):
            require(args.agent and (args.operation == "revoke" or args.role), "Specify the public agent and admission role")
            change_admission("POST" if args.operation == "admit" else "DELETE",
                             args.agent, args.role, manifest["game"]["host_agent_pub_key"], paths["admin_secret_file"])
            print("Authenticated loopback gateway admission change accepted")
        if args.operation == "admission-status":
            require(args.agent, "Specify the public agent to audit")
            print(json.dumps(admission_status(paths["gateway_session_db"], args.agent)))
    except ValidationError as error:
        parser.exit(1, f"Browser alpha deployment command failed. {error}\n")
    except (ValueError, KeyError, TypeError, OSError, BadZipFile, sqlite3.Error,
            subprocess.SubprocessError, http.client.HTTPException):
        # Detailed credentials, gateway responses and environment remain on the operator host.
        parser.exit(1, "Browser alpha deployment command failed. Check configuration, artifact pins and local service status.\n")


if __name__ == "__main__":
    main()
