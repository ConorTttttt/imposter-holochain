#!/usr/bin/env python3
"""Preserve and recover the exact accepted gateway without operator state."""
from argparse import ArgumentParser
import gzip
import os
from pathlib import Path
import shutil
import tempfile

from package import PINS, ValidationError, digest, dump, load, require

BINARY = "h2hc-linker-linux-x86_64"
COMPRESSED = BINARY + ".gz"
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


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["preserve", "restore"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        operation = preserve if args.operation == "preserve" else restore
        operation(args.source, args.destination)
    except ValidationError as error:
        parser.exit(1, f"Gateway archive validation failed. {error}\n")
    except (OSError, EOFError, ValueError):
        parser.exit(1, "Gateway archive operation failed. Check paths, archive integrity and destination ownership.\n")
    print(f'Accepted gateway verified at SHA-256 {PROVENANCE["sha256"]}')


if __name__ == "__main__":
    main()
