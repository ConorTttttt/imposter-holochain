#!/usr/bin/env python3
"""Verify source files against the immutable Git blob IDs returned by GitHub.

This checks EXACT original content, including newlines, before the patch is applied.
It is independent of the Git checkout's SHA and does not access the network.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys


def git_blob_sha(contents: bytes) -> str:
    prefix = b'blob ' + str(len(contents)).encode('ascii') + b'\0'
    return hashlib.sha1(prefix + contents).hexdigest()


def verify(root: Path, manifest: Path) -> int:
    data = json.loads(manifest.read_text())
    problems = []
    for relpath, expected in data['files'].items():
        path = root / relpath
        if not path.is_file():
            problems.append(f'MISSING {relpath}')
            continue
        actual = git_blob_sha(path.read_bytes())
        if actual != expected:
            problems.append(f'MISMATCH {relpath}: expected {expected}, got {actual}')
    for issue in problems:
        print('FAIL:', issue)
    print(f"Verified {len(data['files'])-len(problems)}/{len(data['files'])} pinned source Git blobs")
    return 1 if problems else 0

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source_dir', type=Path)
    parser.add_argument('--manifest', type=Path, default=Path(__file__).with_name('pinned-source-sha.json'))
    args = parser.parse_args()
    sys.exit(verify(args.source_dir, args.manifest))
