#!/usr/bin/env python3
"""Assemble and verify the browser alpha's immutable distribution files."""
from argparse import ArgumentParser
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from zipfile import BadZipFile, ZIP_DEFLATED, ZipFile, ZipInfo

HERE = Path(__file__).resolve().parent
PINS = json.loads((HERE / "pins.json").read_text())
APP_ID = "imposter-browser-poc"
HAPP = f"frontend/{APP_ID}.happ"
DNA = "backend/game.dna"
GATEWAY = "backend/h2hc-linker-linux-x86_64"
EXTENSION = "chromium-hwc.zip"
SETUP = {"browser-setup.html", "browser-setup.js"}
FILES = {
    EXTENSION, HAPP, DNA, GATEWAY, "frontend/browser-demo.html",
    "frontend/deployment.json", "config/public.example.json", "config/operator.example.json",
} | {f"frontend/{name}" for name in SETUP}
SECRET_MARKERS = re.compile(
    rb"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{25,}"
)
CI_MARKERS = (
    b"__imposterRoleFixture", b"__imposterTryRoleCiphertext",
    b"__imposterPauseRoleDelivery", b"__imposterInstalledRoleEvidence",
    b"/__ci_source_chain",
)


class ValidationError(ValueError):
    """A controlled diagnostic from release input validation."""


def require(condition, error):
    if not condition:
        raise ValidationError(error)


def digest(path):
    with path.open("rb") as stream:
        return sha256_stream(stream)


def sha256_stream(stream):
    value = sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(block)
    return value.hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def load(path):
    return json.loads(path.read_text())


def verify_public_bytes(data, label):
    require(not any(marker in data for marker in CI_MARKERS), f"CI instrumentation in {label}")
    require(not SECRET_MARKERS.search(data), f"Private credential marker in {label}")


def check_identity(deployment):
    host, dna, seed = (deployment[k] for k in ("host_agent_pub_key", "dna_hash", "network_seed"))
    require(re.fullmatch(r"uhCAk[A-Za-z0-9_-]{48}", host), "Invalid public host agent hash")
    require(re.fullmatch(r"uhC0k[A-Za-z0-9_-]{48}", dna), "Invalid native DNA hash")
    require(re.fullmatch(r"g1\." + re.escape(host) + r"\.[0-9a-f]{32}", seed),
            "Seed does not bind the supplied host identity")


def check_extension(path):
    with ZipFile(path) as archive:
        names = set()
        allowed_dirs = {"assets", "background", "content", "icons", "inject", "lib", "offscreen", "popup"}
        for member in archive.infolist():
            name = PurePosixPath(member.filename)
            require(str(name) == member.filename and not member.is_dir() and not name.is_absolute()
                    and ".." not in name.parts and member.filename not in names
                    and (member.external_attr >> 16) == 0o100644,
                    "Invalid or duplicate extension archive member")
            require(member.filename == "manifest.json"
                    or (name.parts[0] in allowed_dirs and name.suffix in
                        {".css", ".html", ".js", ".png", ".svg", ".wasm"}),
                    "Unexpected extension asset")
            names.add(member.filename)
            verify_public_bytes(archive.read(member), member.filename)
        manifest = json.loads(archive.read("manifest.json"))
        require(manifest["manifest_version"] == 3 and manifest["background"]["service_worker"]
                == "background/index.js" and "background/index.js" in names,
                "Expected HWC Chromium Manifest V3 service worker")
        return manifest["version"]


def archive_extension(source, path):
    with ZipFile(path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for child in sorted(source.rglob("*")):
            require(not child.is_symlink(), "Symlink in extension build")
            if child.is_file() and child.suffix != ".map":
                member = ZipInfo(child.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
                member.create_system = 3
                member.external_attr = 0o100644 << 16
                archive.writestr(member, child.read_bytes(), ZIP_DEFLATED, compresslevel=9)


def checksums(root):
    return "".join(f"{digest(root / item)}  {item}\n" for item in sorted(FILES | {"release-manifest.json"}))


def verify(root, expected_commit, identity="OPERATOR_SUPPLIED_PUBLIC_INPUT", *, manifest_sha256=None):
    actual = set()
    for member in root.rglob("*"):
        require(not member.is_symlink(), "Symlink in release")
        if member.is_file():
            actual.add(member.relative_to(root).as_posix())
        else:
            require(member.is_dir(), "Unexpected release entry")
    require(actual == FILES | {"release-manifest.json", "SHA256SUMS"}, "Release file inventory differs")
    if manifest_sha256 is not None:
        require(re.fullmatch(r"[0-9a-f]{64}", manifest_sha256)
                and digest(root / "release-manifest.json") == manifest_sha256,
                "Release manifest differs from the operator's trusted checksum")
    require((root / "SHA256SUMS").read_text() == checksums(root), "Release checksums differ")
    manifest = load(root / "release-manifest.json")
    expected_fields = {"schema_version", "release_commit", "pins", "identity_provenance",
                       "external_network_acceptance", "artifacts", "game", "toolchain", "extension_version"}
    require(set(manifest) == expected_fields and manifest["schema_version"] == 1
            and manifest["release_commit"] == expected_commit and manifest["pins"] == PINS
            and manifest["identity_provenance"] == identity
            and manifest["external_network_acceptance"] == "NOT EXECUTED", "Release provenance differs")
    require(manifest["artifacts"] == {item: digest(root / item) for item in sorted(FILES)},
            "Manifest artifact hashes differ")
    require(manifest["toolchain"]["node"] == PINS["node_version"] and
            manifest["toolchain"]["holochain"] == "0.7.0", "Build toolchain pin differs")
    require(digest(root / GATEWAY) == PINS["gateway"]["sha256"], "Gateway executable pin differs")
    require(check_extension(root / EXTENSION) == manifest["extension_version"], "Extension version differs")
    deployment = load(root / "frontend/deployment.json")
    check_identity(deployment)
    require(set(deployment) == {"schema_version", "app_id", "host_agent_pub_key", "dna_hash",
                               "network_seed", "happ_bundle_sha256"}
            and deployment["schema_version"] == 1 and deployment["app_id"] == APP_ID
            and deployment["happ_bundle_sha256"] == manifest["artifacts"][HAPP]
            and manifest["game"] == {**deployment, "dna_bundle_sha256": manifest["artifacts"][DNA]},
            "Public deployment metadata differs from the verified bundle")
    for template in ("public.example.json", "operator.example.json"):
        require(load(root / "config" / template) == load(HERE / template), "Unexpected config template")
    for item in FILES | {"release-manifest.json"}:
        if Path(item).suffix in {".html", ".js", ".json"}:
            verify_public_bytes((root / item).read_bytes(), item)
    return manifest


def assemble(args):
    require(re.fullmatch(r"[0-9a-f]{40}", args.release_commit), "Invalid release source commit")
    native = load(args.native / "deployment.json")
    expected_native_identity = {
        "OPERATOR_SUPPLIED_PUBLIC_INPUT": "UNVERIFIED_OPERATOR_INPUT",
        "EPHEMERAL_CI_ONLY": "EPHEMERAL_HWC_BROWSER_PROFILE",
    }[args.identity]
    require(native["source_head"] == PINS["game_commit"]
            and native["host_identity_source"] == expected_native_identity, "Native packaging identity or pin differs")
    deployment = {"schema_version": 1, "app_id": APP_ID}
    for field in ("host_agent_pub_key", "dna_hash", "network_seed", "happ_bundle_sha256"):
        deployment[field] = native[field]
    check_identity(deployment)
    require(args.out.parent.is_dir() and not args.out.exists() and not args.out.is_symlink(),
            "Output parent must exist and output must be new")
    with tempfile.TemporaryDirectory(dir=args.out.parent, prefix=".alpha-") as work:
        root = Path(work) / "release"
        for directory in ("frontend", "backend", "config"):
            (root / directory).mkdir(parents=True, exist_ok=True)
        for source, target in [(args.native / "app" / f"{APP_ID}.happ", HAPP),
                               (args.native / "dna/game.dna", DNA), (args.gateway, GATEWAY),
                               (args.demo, "frontend/browser-demo.html"),
                               *((HERE / "frontend" / name, "frontend/" + name) for name in sorted(SETUP)),
                               (HERE / "public.example.json", "config/public.example.json"),
                               (HERE / "operator.example.json", "config/operator.example.json")]:
            shutil.copyfile(source, root / target)
        (root / GATEWAY).chmod(0o755)
        require(native["dna_bundle_sha256"] == digest(root / DNA), "Native DNA bytes changed")
        archive_extension(args.extension, root / EXTENSION)
        dump(root / "frontend/deployment.json", deployment)
        dump(root / "release-manifest.json", {
            "schema_version": 1, "release_commit": args.release_commit, "pins": PINS,
            "identity_provenance": args.identity,
            "external_network_acceptance": "NOT EXECUTED",
            "toolchain": {"node": args.node_version, "npm": args.npm_version, "holochain": "0.7.0"},
            "extension_version": check_extension(root / EXTENSION),
            "game": {**deployment, "dna_bundle_sha256": native["dna_bundle_sha256"]},
            "artifacts": {item: digest(root / item) for item in sorted(FILES)},
        })
        (root / "SHA256SUMS").write_text(checksums(root))
        verify(root, args.release_commit, args.identity)
        # Reserve the output name atomically before moving files into it.
        args.out.mkdir()
        try:
            for member in root.iterdir():
                member.rename(args.out / member.name)
        except OSError:
            shutil.rmtree(args.out)
            raise


def main():
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    assembler = commands.add_parser("assemble")
    checker = commands.add_parser("verify")
    for command in (assembler, checker):
        command.add_argument("out", type=Path)
        command.add_argument("--release-commit", required=True)
        command.add_argument("--identity", choices=["OPERATOR_SUPPLIED_PUBLIC_INPUT", "EPHEMERAL_CI_ONLY"],
                             default="OPERATOR_SUPPLIED_PUBLIC_INPUT")
    for name in ("native", "extension", "gateway", "demo"):
        assembler.add_argument(f"--{name}", type=Path, required=True)
    assembler.add_argument("--node-version", required=True)
    assembler.add_argument("--npm-version", required=True)
    checker.add_argument("--manifest-sha256", help="Independently recorded SHA-256 of release-manifest.json")
    args = parser.parse_args()
    try:
        if args.command == "assemble":
            assemble(args)
        else:
            verify(args.out, args.release_commit, args.identity, manifest_sha256=args.manifest_sha256)
    except (ValueError, KeyError, TypeError, OSError, BadZipFile) as error:
        parser.exit(1, f"Browser alpha package verification failed: {error}\n")
    print("Browser alpha checksums, source pins, asset inventory and embedded metadata verified")


if __name__ == "__main__":
    main()
