from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from acceptance import GATES, PENDING, validate, write_record


class AcceptanceRecordSchemaTests(TestCase):
    def setUp(self):
        self.stamp = "2026-01-01T00:00:00Z"
        host, guest_b, guest_c, *authorities = ("uhCAk" + letter * 48 for letter in "ABCDE")
        self.players = [host, guest_b, guest_c]
        self.record = {
            "schema": 1, "release_commit": "a" * 40, "manifest_sha256": "b" * 64,
            "dna": "uhC0k" + "A" * 48, "started_at": self.stamp,
            "network": {"frontend_origin": "https://front.example.test", "gateway_origin": "https://gateway.example.test",
                        "bootstrap_url": "https://bootstrap.example.test", "relay_url": "https://relay.example.test"},
            "players": {"host": host, "guest_b": guest_b, "guest_c": guest_c}, "authorities": authorities,
            "gates": {gate: {"result": PENDING, "observed_at": None, "evidence": None} for gate in GATES},
        }

    def passing_row(self, **evidence):
        return {"result": "PASS", "observed_at": self.stamp, "evidence": evidence}

    def test_reject_duplicate_and_unknown_operator_fields(self):
        validate(self.record)
        duplicate = deepcopy(self.record)
        duplicate["players"]["guest_b"] = duplicate["players"]["guest_c"]
        with self.assertRaisesRegex(ValueError, "distinct public player"):
            validate(duplicate)
        self.record["gates"]["profiles"] = self.passing_row(authenticated_profiles=self.players, session_token="fixture")
        with self.assertRaisesRegex(ValueError, "public evidence for profiles"):
            validate(self.record)

    def test_guest_receipts_require_exact_commit_from_same_round(self):
        lobby, join_b, join_c, commitment, other = ("uhCkk" + letter * 48 for letter in "ABCDE")
        gates = self.record["gates"]
        gates["lobby_joins"] = self.passing_row(lobby=lobby, guest_b_join=join_b, guest_c_join=join_c,
                                               native_valid_profiles=self.players)
        gates["round_start"] = self.passing_row(lobby=lobby, role_commit=commitment, playing_profiles=self.players)
        gates["guest_roles"] = self.passing_row(guest_b_receipt_commit=commitment, guest_c_receipt_commit=other)
        with self.assertRaisesRegex(ValueError, "public evidence for guest_roles"):
            validate(self.record)
        gates["guest_roles"]["evidence"]["guest_c_receipt_commit"] = commitment
        validate(self.record)

    def test_reauthorization_requires_revocation_and_zero_prior_sessions(self):
        _, guest_b, guest_c = self.players
        gates = self.record["gates"]
        gates["revocation"] = self.passing_row(player=guest_b, sessions_before=1, sessions_after=0,
                                               allowed_after=False, browser_disconnected=True)
        gates["reauthorization"] = self.passing_row(player=guest_c, sessions_before_connect=0,
                                                    sessions_after_connect=1, fresh_authenticated_connection=True)
        with self.assertRaisesRegex(ValueError, "public evidence for reauthorization"):
            validate(self.record)
        data = gates["reauthorization"]["evidence"]
        data["player"] = guest_b
        data["sessions_before_connect"] = 1
        with self.assertRaisesRegex(ValueError, "public evidence for reauthorization"):
            validate(self.record)

    def test_initial_record_cannot_replace_an_existing_record(self):
        with TemporaryDirectory() as temp:
            path = Path(temp) / "acceptance.json"
            write_record(path, self.record, new=True)
            initial = path.read_bytes()
            with self.assertRaises(FileExistsError):
                write_record(path, self.record, new=True)
            self.assertEqual(path.read_bytes(), initial)
