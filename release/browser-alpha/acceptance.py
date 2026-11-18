#!/usr/bin/env python3
"""Record the operator-observed alpha gates using only typed public evidence."""
from argparse import ArgumentParser
from datetime import UTC, datetime
import http.client
import json
import os
from pathlib import Path
import re
import tempfile
from zipfile import BadZipFile

from deploy import external_preflight, public_configuration
from package import ValidationError, load, require, verify

GATES = (
    "profiles", "lobby_joins", "round_start", "guest_roles", "guest_isolation", "engine_task",
    "crew_victory", "profile_restart", "revocation", "reauthorization",
)
PENDING = "NOT EXECUTED"
FIELDS = {"schema", "release_commit", "manifest_sha256", "dna", "network", "players", "authorities",
          "started_at", "gates"}


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def action(value):
    return matches(value, r"uhCkk[A-Za-z0-9_-]{48}")


def agents(values, count):
    return isinstance(values, list) and len(values) == count and all(
        matches(value, r"uhCAk[A-Za-z0-9_-]{48}") for value in values
    ) and len(set(values)) == count


def utc_now():
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def time_value(value):
    require(matches(value, r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z"), "Expected a UTC evidence timestamp")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")


def evidence_rules(record):
    players = record["players"]
    all_players = list(players.values())
    guests = [players["guest_b"], players["guest_c"]]
    gates = record["gates"]
    lobby = (gates["lobby_joins"]["evidence"] or {}).get("lobby")
    commit = (gates["round_start"]["evidence"] or {}).get("role_commit")
    revoked = (gates["revocation"]["evidence"] or {}).get("player")

    def all_profiles(values):
        return agents(values, 3) and set(values) == set(all_players)

    def same_lobby(value):
        return action(value) and value == lobby

    def same_commit(value):
        return action(value) and value == commit

    def seat(value):
        return type(value) is int and 0 <= value < 3

    def positive(value):
        return type(value) is int and value > 0

    def exact_count(value, expected):
        return type(value) is int and value == expected

    return {
        "profiles": {"authenticated_profiles": all_profiles},
        "lobby_joins": {"lobby": action, "guest_b_join": action, "guest_c_join": action,
                        "native_valid_profiles": all_profiles},
        "round_start": {"lobby": same_lobby, "role_commit": action, "playing_profiles": all_profiles},
        "guest_roles": {"guest_b_receipt_commit": same_commit, "guest_c_receipt_commit": same_commit},
        "guest_isolation": {"requested_recipient": lambda value: value == players["guest_b"],
                            "guest_c_denied": lambda value: value is True},
        "engine_task": {"task_action": action, "task_count": lambda value: exact_count(value, 1)},
        "crew_victory": {"role_commit": same_commit, "crew_wins_profiles": all_profiles},
        "profile_restart": {"player": lambda value: value in guests, "lobby": same_lobby,
                            "role_commit": same_commit, "seat": seat, "recovered_seat": seat,
                            "matching_dna_and_authenticated": lambda value: value is True},
        "revocation": {"player": lambda value: value in guests, "sessions_before": positive,
                       "sessions_after": lambda value: exact_count(value, 0),
                       "allowed_after": lambda value: value is False,
                       "browser_disconnected": lambda value: value is True},
        "reauthorization": {"player": lambda value: value in guests and value == revoked,
                            "sessions_before_connect": lambda value: exact_count(value, 0),
                            "sessions_after_connect": positive,
                            "fresh_authenticated_connection": lambda value: value is True},
    }


def validate(record):
    require(set(record) == FIELDS and type(record["schema"]) is int and record["schema"] == 1,
            "Acceptance record fields differ")
    require(matches(record["release_commit"], r"[0-9a-f]{40}")
            and matches(record["manifest_sha256"], r"[0-9a-f]{64}")
            and matches(record["dna"], r"uhC0k[A-Za-z0-9_-]{48}"), "Invalid release identity")
    public_configuration(record["network"])
    players = record["players"]
    require(set(players) == {"host", "guest_b", "guest_c"} and agents(list(players.values()), 3),
            "Expected three distinct public player identities")
    require(agents(record["authorities"], 2) and not set(record["authorities"]).intersection(players.values()),
            "Expected two separate native authority identities")
    start = time_value(record["started_at"])
    gates = record["gates"]
    require(set(gates) == set(GATES), "Expected exactly the ten operator gates")
    for row in gates.values():
        require(set(row) == {"result", "observed_at", "evidence"} and row["result"] in {PENDING, "PASS", "FAIL"},
                "Invalid gate result fields")
        if row["result"] == PENDING:
            require(row["observed_at"] is None, "A pending gate has no observation time")
        else:
            require(time_value(row["observed_at"]) >= start, "Gate observation predates acceptance")
        require(isinstance(row["evidence"], dict) if row["result"] == "PASS" else row["evidence"] is None,
                "Only a passing gate can carry typed public evidence")

    rules = evidence_rules(record)
    for name, row in gates.items():
        if row["result"] == "PASS":
            data = row["evidence"]
            require(set(data) == set(rules[name]) and all(check(data[key]) for key, check in rules[name].items()),
                    f"Missing or mismatched public evidence for {name}")
    actions = []
    for name, keys in (("lobby_joins", ("lobby", "guest_b_join", "guest_c_join")),
                       ("round_start", ("role_commit",)), ("engine_task", ("task_action",))):
        if gates[name]["result"] == "PASS":
            actions.extend(gates[name]["evidence"][key] for key in keys)
    require(len(actions) == len(set(actions)), "Each recorded native action must have a distinct hash")
    restart = gates["profile_restart"]["evidence"]
    if restart is not None:
        require(restart["seat"] == restart["recovered_seat"], "The restarted profile recovered a different seat")


def verified_release(args):
    network = public_configuration(load(args.public))
    manifest = verify(args.release, args.release_commit, manifest_sha256=args.manifest_sha256)
    return network, manifest["game"]


def write_record(path, record, *, new=False):
    validate(record)
    with tempfile.TemporaryDirectory(prefix=".acceptance-", dir=path.parent) as temp:
        pending = Path(temp) / "record.json"
        pending.write_text(json.dumps(record, indent=2) + "\n")
        pending.chmod(0o600)
        if new:
            os.link(pending, path)
        else:
            os.replace(pending, path)


def main():
    parser = ArgumentParser(description=__doc__)
    operations = parser.add_subparsers(dest="operation", required=True)
    for name in ("init", "record", "status", "verify"):
        command = operations.add_parser(name)
        command.add_argument("file", type=Path)
        if name in {"init", "verify"}:
            command.add_argument("--public", required=True, type=Path)
            command.add_argument("--release", required=True, type=Path)
            command.add_argument("--release-commit", required=True)
            command.add_argument("--manifest-sha256", required=True)
        if name == "init":
            command.add_argument("--native-status", type=Path, required=True)
            command.add_argument("--guest-b", required=True)
            command.add_argument("--guest-c", required=True)
        if name == "record":
            command.add_argument("gate", choices=GATES)
            command.add_argument("result", choices=["PASS", "FAIL"])
            command.add_argument("--evidence", type=Path)
    args = parser.parse_args()

    try:
        if args.operation == "init":
            network, game = verified_release(args)
            native = load(args.native_status)
            require(set(native) == {"dna", "authorities"} and native["dna"] == game["dna_hash"],
                    "Native authority report differs from the verified DNA")
            record = {"schema": 1, "release_commit": args.release_commit, "manifest_sha256": args.manifest_sha256,
                      "dna": game["dna_hash"], "network": network, "started_at": utc_now(),
                      "players": {"host": game["host_agent_pub_key"], "guest_b": args.guest_b, "guest_c": args.guest_c},
                      "authorities": native["authorities"],
                      "gates": {gate: {"result": PENDING, "observed_at": None, "evidence": None} for gate in GATES}}
            validate(record)
            external_preflight(network, args.release)
            write_record(args.file, record, new=True)
        else:
            record = load(args.file)
            validate(record)
        if args.operation == "record":
            require(record["gates"][args.gate]["result"] == PENDING, "Preserve prior results and use a new record to retest")
            require((args.result == "PASS") == bool(args.evidence), "PASS requires a public evidence JSON object")
            record["gates"][args.gate] = {"result": args.result, "observed_at": utc_now(),
                                         "evidence": load(args.evidence) if args.evidence else None}
            write_record(args.file, record)
        if args.operation == "verify":
            network, game = verified_release(args)
            require(record["release_commit"] == args.release_commit and record["manifest_sha256"] == args.manifest_sha256
                    and record["network"] == network and record["dna"] == game["dna_hash"]
                    and record["players"]["host"] == game["host_agent_pub_key"], "Acceptance record belongs to another deployment")
            require(all(row["result"] == "PASS" for row in record["gates"].values()),
                    "Acceptance requires a passing result for every operator gate")
            external_preflight(network, args.release)
            print("External HTTPS/WSS preflight passed and all ten operator-attested gates are recorded")
        else:
            for gate in GATES:
                print(f"{gate} {record['gates'][gate]['result']}")
    except ValidationError as error:
        parser.exit(1, f"Acceptance validation failed. {error}\n")
    except (OSError, TypeError, KeyError, ValueError, BadZipFile, http.client.HTTPException):
        parser.exit(1, "Acceptance command failed. Check the deployment, verified release and public evidence files.\n")


if __name__ == "__main__":
    main()
