#!/usr/bin/env python3
"""Read-only audit of the two ephemeral Holochain 0.7 DHT stores.

Use only inside isolated CI after native conductor start. Reads public DHT
metadata (never Lair keystores or private entries); prints JSON with public
HoloHashes/statuses only. Does not modify databases or integrity validators.
The accepted status is meaningful ONLY for an exact matched ChainOp row
with locally_validated=1 and when_integrated populated.

Usage: audit_native_dht.py <ephemeral-native-sandbox-root> <host-agent-holohash>
    [lobby-action-holohash [op-hash ...]]
"""
import base64
import json
import pathlib
import sqlite3
import sys
from urllib.parse import quote


def holo_hash(blob):
    if blob is None:
        return None
    return "u" + base64.urlsafe_b64encode(bytes(blob)).decode("ascii").rstrip("=")


def field_names(cnx, table):
    return {row[1] for row in cnx.execute(f"PRAGMA table_info({table})")}


def one_table(cnx, table, expected_host, target_ops, lobby_action, negative_agent):
    fields = field_names(cnx, table)
    if not {"hash", "action_hash", "op_type"}.issubset(fields):
        return []
    statuses = [
        f for f in ("validation_status", "sys_validation_status",
                    "app_validation_status", "locally_validated",
                    "when_integrated") if f in fields
    ]
    cols = ["hash", "action_hash", "op_type"] + statuses
    rows = cnx.execute("SELECT " + ",".join(cols) + " FROM " + table)
    action_fields = field_names(cnx, "Action") if any(
        t[0] == "Action" for t in cnx.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")) else set()
    result = []
    for row in rows:
        d = dict(zip(cols, row))
        op_id = holo_hash(d["hash"])
        action = holo_hash(d["action_hash"])
        # Match requested ops, genuine lobby, or the isolated test author.
        author = None
        action_type = None
        record_validity = None
        action_seq = None
        if {"hash", "author"}.issubset(action_fields):
            a_cols = ["author"] + [
                x for x in ("action_type", "record_validity", "seq") if x in action_fields]
            a = cnx.execute("SELECT " + ",".join(a_cols) +
                " FROM Action WHERE hash=?", (d["action_hash"],)).fetchone()
            if a:
                av = dict(zip(a_cols, a))
                author = holo_hash(av.get("author"))
                action_type = av.get("action_type")
                record_validity = av.get("record_validity")
                action_seq = av.get("seq")
        matches_negative = bool(
            negative_agent and author == negative_agent
            and action_seq is not None and action_seq >= 4
        )
        if op_id not in target_ops and action != lobby_action and not matches_negative:
            continue
        item = {
            "op_hash": op_id, "action_hash": action,
            "matched_lobby_action": bool(lobby_action and action == lobby_action),
            "op_type": d["op_type"], "author": author,
            "matches_host": author == expected_host if author else None,
            "action_type": action_type, "record_validity": record_validity,
            "seq": action_seq, "matches_negative_author": matches_negative,
            "table": table
        }
        for f in statuses:
            item[f] = d[f]
        item["exact_native_valid_integrated"] = (
            table == "ChainOp" and d.get("validation_status") == 1
            and d.get("locally_validated") == 1
            and d.get("when_integrated") is not None
            and author == expected_host
        )
        result.append(item)
    return result


def main():
    if len(sys.argv) < 3:
        raise SystemExit("expected native root and host public agent")
    root = pathlib.Path(sys.argv[1]).resolve()
    host = sys.argv[2]
    lobby = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "null" else None
    extra = sys.argv[4:]
    negative_agent = None
    if "--invalid-agent" in extra:
        idx = extra.index("--invalid-agent")
        if idx + 1 >= len(extra):
            raise SystemExit("missing --invalid-agent value")
        negative_agent = extra[idx + 1]
        extra = extra[:idx] + extra[idx + 2:]
    targets = set(extra)
    out = {
        "schema_version": 1,
        "readonly": True,
        "host_agent": host,
        "lobby_action_hash": lobby,
        "target_op_hashes": sorted(targets),
        "negative_isolated_agent": negative_agent,
        "conductors": {},
        "warnings": [],
    }
    if not root.is_dir():
        raise SystemExit("native sandbox root does not exist")
    for sandbox in ("conductor-a", "conductor-b"):
        d = root / sandbox
        entries = []
        count = 0
        candidates = []
        if d.is_dir():
            for db in d.rglob("*"):
                if not db.is_file() or db.suffix not in (".sqlite", ".sqlite3", ".db"):
                    continue
                try:
                    # Only archive metadata, never file contents, paths or secrets.
                    with db.open("rb") as fd:
                        sqlite_header = fd.read(16) == b"SQLite format 3\x00"
                    candidates.append({"suffix": db.suffix,
                                       "sqlite_header": sqlite_header})
                    if not sqlite_header:
                        continue
                    url = "file:" + quote(str(db), safe="/") + "?mode=ro"
                    with sqlite3.connect(url, uri=True, timeout=2) as cnx:
                        tables = {t[0] for t in cnx.execute(
                            "SELECT name FROM sqlite_master WHERE type='table'")}
                        if "ChainOp" not in tables and "LimboChainOp" not in tables:
                            continue
                        count += 1
                        for table in ("ChainOp", "LimboChainOp"):
                            if table in tables:
                                entries.extend(one_table(
                                    cnx, table, host, targets, lobby, negative_agent))
                except (sqlite3.DatabaseError, OSError) as e:
                    # Replace temp storage path and filenames before emitting.
                    message = str(e).replace(str(db), "<db>").replace(str(root), "<root>")
                    out["warnings"].append({
                        "conductor": sandbox,
                        "error_type": type(e).__name__,
                        "error_category": (
                            "LOCKED" if "locked" in message.lower() else
                            "NOT_DATABASE" if "not a database" in message.lower() else
                            "OPEN_FAILED" if "unable to open" in message.lower() else
                            "SCHEMA" if "no such" in message.lower() else
                            "OTHER"),
                        "safe_message": message[:160],
                        "suffix": db.suffix
                    })
        out["conductors"][sandbox] = {
            "dht_database_count": count, "matched_ops": entries,
            "candidates": candidates
        }
    print(json.dumps(out, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
