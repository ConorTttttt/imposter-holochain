"""Stage and atomically switch the RC1 static site. Native and gateway state live elsewhere."""
from fcntl import LOCK_EX, flock
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from package import HAPP, SETUP, require

FRONTEND = SETUP | {"browser-demo.html", "deployment.json", Path(HAPP).name, "browser-config.json"}
SNAPSHOT = re.compile(r"[0-9a-f]{64}")


def snapshot_id(files):
    index = {name: sha256(content).hexdigest() for name, content in files.items()}
    return sha256(json.dumps(index, sort_keys=True).encode()).hexdigest()


def atomic_file(path, content, staging):
    with tempfile.NamedTemporaryFile(dir=staging, delete=False) as stage:
        pending = Path(stage.name)
        try:
            stage.write(content)
            stage.flush()
            os.fsync(stage.fileno())
            os.replace(pending, path)
        finally:
            pending.unlink(missing_ok=True)


def verify_snapshot(path, files):
    require(path.is_dir() and not path.is_symlink(), "Static snapshot directory is missing or unsafe")
    require({file.name for file in path.iterdir()} == set(files), "Static snapshot inventory differs")
    for name, content in files.items():
        file = path / name
        require(file.is_file() and not file.is_symlink() and file.read_bytes() == content,
                "Static snapshot content differs")


def activate_site(root, files, *, rollback=False):
    names = set(files)
    require(names in (SETUP, FRONTEND), "Unexpected static release files")
    bootstrap = names == SETUP
    require(not (bootstrap and rollback), "Rollback requires a complete previously published release")
    root.mkdir(mode=0o755, parents=True, exist_ok=True)
    require(not root.is_symlink(), "Use a real directory for the managed static root")
    lock = os.open(root / ".site-lock", os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
    with os.fdopen(lock, "r+b") as stream:
        flock(stream, LOCK_EX)
        require({file.name for file in root.iterdir()} <= {".site-lock", "current", "releases", ".binding.json"},
                "Choose a new managed static root. Keep the existing flat site for recovery.")
        versions = root / "releases"
        versions.mkdir(mode=0o755, exist_ok=True)
        require(not versions.is_symlink(), "Unsafe static releases directory")
        current = root / "current"
        binding = root / ".binding.json"
        require(not binding.is_symlink(), "Unsafe static deployment binding")
        if current.is_symlink():
            target = Path(os.readlink(current))
            require(len(target.parts) == 2 and target.parts[0] == "releases"
                    and SNAPSHOT.fullmatch(target.parts[1])
                    and (root / target).is_dir() and not (root / target).is_symlink(),
                    "Unsafe active static snapshot link")
        else:
            require(not current.exists(), "The active static site must be a managed link")
        if bootstrap:
            require(not binding.exists(), "This static root already has a bound game")
        else:
            # Both documents are verified public bytes from the caller. Binding
            # the exact hApp and origins keeps rollback on the installed world.
            state = json.dumps({
                name: json.loads(files[name]) for name in ("deployment.json", "browser-config.json")
            }, sort_keys=True).encode()
            if binding.exists():
                require(binding.is_file() and binding.read_bytes() == state,
                        "Static release changes the bound game or origins")
            else:
                require(not rollback, "No bound game has been published here")

        version = snapshot_id(files)
        snapshot = versions / version
        if rollback or snapshot.exists() or snapshot.is_symlink():
            verify_snapshot(snapshot, files)
        else:
            stage = Path(tempfile.mkdtemp(prefix=".stage-", dir=versions))
            try:
                for name, content in files.items():
                    path = stage / name
                    with path.open("wb") as asset:
                        asset.write(content)
                        asset.flush()
                        os.fsync(asset.fileno())
                    path.chmod(0o644)
                stage.chmod(0o755)
                stage.rename(snapshot)
            finally:
                if stage.exists():
                    shutil.rmtree(stage)
        if not bootstrap and not binding.exists():
            atomic_file(binding, state, versions)
        # Rename the link in the same filesystem. Requests see a complete
        # snapshot on either side of the change.
        with tempfile.TemporaryDirectory(prefix=".switch-", dir=versions) as stage:
            pending = Path(stage) / "current"
            pending.symlink_to(Path("releases") / version)
            os.replace(pending, current)
        return version
