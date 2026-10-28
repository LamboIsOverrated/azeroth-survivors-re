import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('apply_anticheat', HERE/'apply_anticheat.py')
carry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(carry)


class AnticheatCarryTests(unittest.TestCase):
    def test_checked_in_patch_and_header_are_the_reviewed_manifest(self):
        manifest = carry.load_manifest(HERE)
        self.assertEqual(manifest['revision'], 'de8f72993b9e1faa1bf92dd5505f3daec5cea3ce')
        self.assertEqual(len(manifest['files']), 3)

    def test_source_hash_mismatch_and_missing_file_fail_closed(self):
        manifest = carry.load_manifest(HERE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fixture = copy.deepcopy(manifest)
            for name, hashes in fixture['files'].items():
                path = root/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture\n')
                hashes['before'] = hashlib.sha256(b'fixture\n').hexdigest()
            carry.verify_files(root, fixture, 'before')
            first = root/next(iter(fixture['files']))
            first.write_text('changed\n')
            with self.assertRaisesRegex(ValueError, 'source mismatch'):
                carry.verify_files(root, fixture, 'before')
            first.unlink()
            with self.assertRaisesRegex(ValueError, 'missing'):
                carry.verify_files(root, fixture, 'before')

    def test_manifest_cannot_escape_the_exact_anticheat_paths(self):
        manifest = carry.load_manifest(HERE)
        for malicious in ('../elsewhere', '/absolute', 'src/game/World/World.cpp'):
            with self.subTest(malicious=malicious), tempfile.TemporaryDirectory() as temporary:
                changed = copy.deepcopy(manifest)
                changed['files'][malicious] = next(iter(changed['files'].values()))
                with self.assertRaisesRegex(ValueError, 'paths'):
                    carry.verify_files(Path(temporary), changed, 'before')

    def test_modified_patch_without_matching_review_metadata_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ('anticheat-sources.json', 'browser-anticheat.patch', 'BrowserMovementBudget.h'):
                (root/name).write_bytes((HERE/name).read_bytes())
            (root/'browser-anticheat.patch').write_text('different source carry\n')
            with self.assertRaisesRegex(ValueError, 'patch'):
                carry.load_manifest(root)


if __name__ == '__main__':
    unittest.main()
