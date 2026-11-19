#!/usr/bin/env python3
"""Package and verify the unsigned Firefox desktop development add-on."""

from argparse import ArgumentParser
from pathlib import Path, PurePosixPath
import shutil
from tempfile import TemporaryDirectory
from zipfile import BadZipFile, ZipFile
import json

from package import archive_extension, digest, require, verify_public_bytes

ADDON = "firefox-desktop-hwc.zip"
ALLOWED_DIRS = {"assets", "background", "content", "icons", "inject", "lib", "offscreen", "popup"}
ALLOWED_SUFFIXES = {".css", ".html", ".js", ".png", ".svg", ".wasm"}


def verify(root):
    path = root / ADDON
    require((root / "SHA256SUMS").read_text() == f"{digest(path)}  {ADDON}\n",
            "Firefox archive checksum differs")
    with ZipFile(path) as archive:
        names = set()
        for member in archive.infolist():
            name = PurePosixPath(member.filename)
            require(str(name) == member.filename and not name.is_absolute()
                    and ".." not in name.parts and member.filename not in names
                    and not member.is_dir() and (member.external_attr >> 16) == 0o100644,
                    "Invalid or duplicate Firefox archive member")
            require(member.filename == "manifest.json"
                    or (name.parts[0] in ALLOWED_DIRS and name.suffix in ALLOWED_SUFFIXES),
                    f"Unexpected Firefox asset {member.filename}")
            names.add(member.filename)
            verify_public_bytes(archive.read(member), member.filename)

        manifest = json.loads(archive.read("manifest.json"))
        require(manifest.get("manifest_version") == 3
                and manifest.get("background") == {"scripts": ["background/index.js"]}
                and manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id"),
                "Expected Firefox Manifest V3 background script and Gecko add-on ID")
        require("offscreen" not in manifest.get("permissions", [])
                and not {"offscreen/offscreen.html", "offscreen/offscreen.js",
                         "offscreen/sqlite-worker.js"} & names,
                "Chromium offscreen dependencies in Firefox package")
        expected = {
            "background/index.js", "content/index.js", "inject/index.js",
            "offscreen/ribosome-worker.js", "offscreen/sqlite3.wasm", "popup/index.html",
        } | set(manifest.get("icons", {}).values())
        require(expected <= names, f"Missing Firefox assets {sorted(expected - names)}")
        require(archive.read("offscreen/sqlite3.wasm").startswith(b"\0asm\1\0\0\0"),
                "Invalid SQLite WebAssembly asset")


def build(source, output):
    require(source.is_dir() and not output.exists(), "Expected extension build and new output directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=output.parent) as folder:
        staged = Path(folder)
        package = staged / ADDON
        archive_extension(source, package)
        (staged / "SHA256SUMS").write_text(f"{digest(package)}  {ADDON}\n")
        verify(staged)
        output.mkdir()
        shutil.move(package, output / ADDON)
        shutil.move(staged / "SHA256SUMS", output / "SHA256SUMS")


def main():
    parser = ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build")
    build_parser.add_argument("source", type=Path)
    build_parser.add_argument("output", type=Path)
    commands.add_parser("verify").add_argument("output", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args.source, args.output)
        else:
            verify(args.output)
    except (BadZipFile, KeyError, OSError, ValueError) as error:
        raise SystemExit(f"Firefox development package verification failed. {error}") from None
    print("Firefox desktop development package and SHA-256 verified")


if __name__ == "__main__":
    main()
