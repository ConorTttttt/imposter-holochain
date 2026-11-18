#!/usr/bin/env python3
"""Preserve and recover the exact accepted gateway without operator state."""
from argparse import ArgumentParser
import gzip
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from package import PINS, ValidationError, digest, dump, load, require

BINARY = "h2hc-linker-linux-x86_64"
COMPRESSED = BINARY + ".gz"
REPOSITORY = "https://github.com/ConorTttttt/imposter-holochain.git"
ARCHIVE_REF = "refs/heads/archive/browser-alpha-gateway-14428255589"
ARCHIVE_COMMIT = "81ddc627cdac30d1af42ea67bc803a570ad93925"
PROVENANCE = {
    **PINS["gateway"],
    "actions_zip_sha256": "18a28177df7017d170360845ac24e48e491194a839e6764bb331481256ec856a",
}


def preserve(artifact, out):
    binary = artifact / BINARY
    require(digest(binary) == PROVENANCE["sha256"], "Accepted gateway checksum differs")
    require((artifact / "h2hc-applied-source-commit.txt").read_text().strip() == PROVENANCE["source_commit"],
            "Gateway source commit differs")
    build = (artifact / "build-provenance.txt").read_text().splitlines()
    require(f'SOURCE_H2HC={PROVENANCE["source_commit"]}' in build
            and f'SOURCE_IMPOSTER={PROVENANCE["recipe_commit"]}' in build, "Gateway build provenance differs")
    result = (artifact / "role-smoke-result.txt").read_text().splitlines()
    require("ROLE_GATEWAY_THREE_AGENT_NETWORK=PASS; HWC_RECEIVER=NOT_TESTED" in result,
            "Accepted gateway network check is missing")
    out.mkdir()
    with binary.open("rb") as source, (out / COMPRESSED).open("xb") as target:
        with gzip.GzipFile(filename="", mode="wb", fileobj=target, mtime=0) as compressed:
            shutil.copyfileobj(source, compressed)
    dump(out / "provenance.json", PROVENANCE)


def restore(archive, out):
    require({path.name for path in archive.iterdir()} == {COMPRESSED, "provenance.json"},
            "Gateway archive inventory differs")
    require(load(archive / "provenance.json") == PROVENANCE, "Gateway archive provenance differs")
    with tempfile.TemporaryDirectory(prefix=".gateway-", dir=out.parent) as temp:
        pending = Path(temp) / BINARY
        with gzip.open(archive / COMPRESSED, "rb") as source, pending.open("xb") as target:
            shutil.copyfileobj(source, target)
        require(digest(pending) == PROVENANCE["sha256"], "Recovered gateway checksum differs")
        pending.chmod(0o755)
        os.link(pending, out)


def fetch(out):
    require(not out.exists() and not out.is_symlink(), "Use a new gateway archive directory")
    with tempfile.TemporaryDirectory(prefix=".gateway-archive-", dir=out.parent) as temp:
        root = Path(temp)
        repo = root / "git"
        subprocess.run(["git", "init", "--quiet", repo], check=True)
        git = ["git", "-C", repo]
        subprocess.run([*git, "fetch", "--quiet", "--no-tags", "--depth=1", REPOSITORY, ARCHIVE_REF],
                       check=True, timeout=180)
        commit = subprocess.check_output([*git, "rev-parse", "FETCH_HEAD"], text=True).strip()
        require(commit == ARCHIVE_COMMIT, "Gateway archive commit differs")
        archive = root / "archive"
        archive.mkdir()
        for name in (COMPRESSED, "provenance.json"):
            with (archive / name).open("xb") as stream:
                subprocess.run([*git, "show", f"{commit}:{name}"], stdout=stream, check=True)
        restore(archive, root / BINARY)
        out.mkdir()
        for file in archive.iterdir():
            file.rename(out / file.name)


def main():
    parser = ArgumentParser(description=__doc__)
    operations = parser.add_subparsers(dest="operation", required=True)
    for operation in ("preserve", "restore"):
        command = operations.add_parser(operation)
        command.add_argument("source", type=Path)
        command.add_argument("destination", type=Path)
    operations.add_parser("fetch").add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "fetch":
            fetch(args.destination)
        else:
            operation = preserve if args.operation == "preserve" else restore
            operation(args.source, args.destination)
    except ValidationError as error:
        parser.exit(1, f"Gateway archive validation failed. {error}\n")
    except (OSError, EOFError, ValueError, subprocess.SubprocessError):
        parser.exit(1, "Gateway archive operation failed. Check paths, archive integrity and destination ownership.\n")
    print(f'Accepted gateway verified at SHA-256 {PROVENANCE["sha256"]}')


if __name__ == "__main__":
    main()
