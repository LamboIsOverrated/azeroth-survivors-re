"""Behavior tests for a fail-closed, offline pinned-source audit.

The fixtures are hand-written. Hashes identify reviewed source bytes, rather
than asserting source wording as a substitute for exercising the checker.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


AUDITOR = pathlib.Path(__file__).parents[1] / "check_mutations.py"
REVISION = "de8f72993b9e1faa1bf92dd5505f3daec5cea3ce"
BASE = "void Player::Reward() { ModifyMoney(10); }\n"


class MutationAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "source"
        self.file = self.source / "src/game/Player.cpp"
        self.file.parent.mkdir(parents=True)
        self.file.write_bytes(BASE.encode())
        self.manifest = self.root / "review.json"
        self.event_map = self.root / "events.json"
        self.review = {
            "schema": 1,
            "repository": "https://github.com/cmangos/mangos-classic",
            "revision": REVISION,
            "coverage": ["src"],
            "files": {"src/game/Player.cpp": hashlib.sha256(BASE.encode()).hexdigest()},
            "sites": [{"path": "src/game/Player.cpp", "line": 1,
                       "kind": "money-api", "symbol": "ModifyMoney", "ordinal": 1}],
        }

    def run_audit(self, events=None):
        self.manifest.write_text(json.dumps(self.review), encoding="utf-8")
        command = [sys.executable, str(AUDITOR), "--source", str(self.source),
                   "--manifest", str(self.manifest), "--json"]
        if events is not None:
            self.event_map.write_text(json.dumps(events), encoding="utf-8")
            command += ["--event-map", str(self.event_map)]
        result = subprocess.run(command,
                                capture_output=True, text=True)
        return result, json.loads(result.stdout) if result.stdout.startswith("{") else {}

    def test_exact_reviewed_source_passes_without_network_or_git(self):
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertEqual(report.get("status"), "reviewed-source-match")
        self.assertEqual(report.get("site_count"), 1)

    def test_new_call_in_reviewed_file_is_rejected(self):
        self.file.write_text(BASE + "void Bypass() { player->ModifyMoney(999); }\n")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("changed-file:src/game/Player.cpp", report.get("errors", []))
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:money-api:ModifyMoney:1", report.get("errors", []))

    def test_new_direct_write_using_different_spelling_is_rejected(self):
        # Coverage hashes catch a bypass even if its syntax evades token discovery.
        self.file.write_text(BASE + "void Bypass() { reinterpret_cast<int*>(this)[42] = 999; }\n")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("changed-file:src/game/Player.cpp", report.get("errors", []))

    def test_new_source_file_cannot_hide_outside_known_money_files(self):
        new = self.source / "src/game/Hidden.cpp"
        new.write_text("void Hidden() { SetUInt32Value(1234, 999); }\n")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreviewed-file:src/game/Hidden.cpp", report.get("errors", []))

    def test_missing_reviewed_file_is_rejected(self):
        self.file.unlink()
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing-file:src/game/Player.cpp", report.get("errors", []))

    def test_wrong_pin_cannot_be_authorized_by_self_reported_manifest(self):
        self.review["revision"] = "a" * 40
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 2)
        self.assertIn("unsupported-revision", report.get("errors", []))

    def test_manifest_path_traversal_is_rejected(self):
        self.review["files"]["../escape.cpp"] = "a" * 64
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 2)
        self.assertIn("unsafe-manifest-path", report.get("errors", []))

    def test_symlink_source_is_rejected(self):
        other = self.root / "outside.cpp"
        other.write_text(BASE)
        self.file.unlink()
        try:
            self.file.symlink_to(other)
        except OSError:
            self.skipTest("symlinks unavailable for this Windows account")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("symlink-file:src/game/Player.cpp", report.get("errors", []))

    def test_omitted_expected_site_is_rejected_even_with_matching_file_hash(self):
        self.review["sites"] = []
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreviewed-site:src/game/Player.cpp:1:money-api:ModifyMoney:1", report.get("errors", []))

    def test_comments_do_not_create_false_money_operations(self):
        content = "// ModifyMoney(90);\n/* SetMoney(8); */\n" + BASE
        self.file.write_bytes(content.encode())
        self.review["files"]["src/game/Player.cpp"] = hashlib.sha256(content.encode()).hexdigest()
        self.review["sites"][0]["line"] = 3
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertEqual(report.get("site_count"), 1)

    def test_direct_coinage_field_write_is_reported(self):
        self.file.write_text(BASE + "SetUInt32Value(PLAYER_FIELD_COINAGE, 500);\n")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:coinage-field:PLAYER_FIELD_COINAGE:1", report.get("errors", []))

    def test_cod_and_unqualified_auction_escrow_writes_are_reported(self):
        self.file.write_text(BASE + "m->COD = 0; bid = newbid; m_gold = 0;\n")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:escrow-assignment:COD:1", report.get("errors", []))
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:escrow-assignment:bid:1", report.get("errors", []))
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:escrow-assignment:m_gold:1", report.get("errors", []))

    def test_generic_runtime_field_writers_are_reported(self):
        self.file.write_text(BASE + "target->SetFloatValue(field, bits);\n")
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:generic-field-write:SetFloatValue:1", report.get("errors", []))

    def test_money_sql_update_is_reported(self):
        self.file.write_text(BASE + 'db.Execute("UPDATE characters SET money = 999");\n')
        result, report = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreviewed-site:src/game/Player.cpp:2:money-sql:UPDATE characters:1", report.get("errors", []))

    def test_missing_event_policy_cannot_pass_source_match(self):
        events = {"schema": 1, "revision": REVISION, "event_sites": [], "helper_sites": []}
        result, report = self.run_audit(events)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unclassified-money-api:src/game/Player.cpp:1:ModifyMoney", report.get("errors", []))

    def test_explicit_event_policy_covers_real_call(self):
        events = {"schema": 1, "revision": REVISION,
                  "event_sites": [{"path": "src/game/Player.cpp", "line": 1,
                                   "symbol": "ModifyMoney", "family": "quest-reward",
                                   "required_policy": "funded-issue"}], "helper_sites": []}
        result, report = self.run_audit(events)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertEqual(report.get("classified_money_api_count"), 1)

    def test_omitting_direct_start_money_policy_cannot_pass(self):
        path = "src/game/Entities/Player.cpp"
        content = "SetUInt32Value(PLAYER_FIELD_COINAGE, startMoney);\n"
        initial = self.source / path
        initial.parent.mkdir(parents=True)
        initial.write_bytes(content.encode())
        self.review["files"][path] = hashlib.sha256(content.encode()).hexdigest()
        self.review["sites"].append({"path": path, "line": 1, "kind": "coinage-field",
                                     "symbol": "PLAYER_FIELD_COINAGE", "ordinal": 1})
        events = {"schema": 1, "revision": REVISION,
                  "event_sites": [{"path": "src/game/Player.cpp", "line": 1,
                                   "symbol": "ModifyMoney", "family": "quest-reward",
                                   "required_policy": "funded-issue"}], "helper_sites": []}
        result, report = self.run_audit(events)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unclassified-direct-money-write:src/game/Entities/Player.cpp:1:SetUInt32Value", report.get("errors", []))


if __name__ == "__main__":
    unittest.main()
