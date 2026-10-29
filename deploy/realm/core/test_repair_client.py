import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from test_adt_repair import synthetic_adt

spec = importlib.util.spec_from_file_location('repair_client', Path(__file__).with_name('repair_client.py'))
repair_client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair_client)


class FixtureMpq:
    def __init__(self, full):
        self.full = full
        self.appended = {}

    def read(self, archive, entry, workspace):
        if archive.name == 'patch.MPQ':
            return self.full[:len(self.full)//2], len(self.full), False
        if archive.name == 'terrain.MPQ':
            return self.full, len(self.full), True
        return self.appended.get(str(archive), b''), len(self.full), True

    def append(self, archive, entry, data, workspace):
        archive.write_bytes(archive.read_bytes() + b'REPAIRED' + data)
        self.appended[str(archive)] = data


class ClientRepairTests(unittest.TestCase):
    def setup_source(self, root):
        source = root / 'original/Data'
        source.mkdir(parents=True)
        for name in ['patch.MPQ', 'patch-2.MPQ', 'terrain.MPQ', 'model.MPQ']:
            (source / name).write_bytes(('operator fixture ' + name).encode())
        full = synthetic_adt()
        overlay = (source/'patch-2.MPQ').read_bytes() + b'REPAIRED' + full
        proof = dict(source_version='synthetic-fixture-v1',
                     entry='World/Maps/Kalimdor/Kalimdor_33_49.adt',
                     prefix_size=len(full)//2, restored_size=len(full),
                     prefix_sha256=hashlib.sha256(full[:len(full)//2]).hexdigest(),
                     restored_sha256=hashlib.sha256(full).hexdigest(),
                     archives={name: dict(size=(source/name).stat().st_size,
                                          sha256=hashlib.sha256((source/name).read_bytes()).hexdigest())
                               for name in ['patch.MPQ', 'patch-2.MPQ', 'terrain.MPQ', 'model.MPQ']},
                     derived_overlay=dict(size=len(overlay), sha256=hashlib.sha256(overlay).hexdigest()))
        return source, full, proof

    def test_production_profile_pins_all_fourteen_original_archives(self):
        self.assertEqual(len(repair_client.KNOWN['archives']), 14)
        self.assertEqual(repair_client.KNOWN['derived_overlay']['size'], 9597150)

    def test_derived_repair_preserves_originals_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, full, proof = self.setup_source(root)
            before = {p.name: p.read_bytes() for p in source.iterdir()}
            derived = root / 'derived/Data'
            manifest = repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            self.assertEqual(before, {p.name: p.read_bytes() for p in source.iterdir()})
            self.assertEqual((derived/'model.MPQ').read_bytes(), before['model.MPQ'])
            self.assertNotEqual((derived/'patch-2.MPQ').read_bytes(), before['patch-2.MPQ'])
            self.assertEqual(manifest['restored_sha256'], proof['restored_sha256'])
            self.assertTrue((derived/'.client-data.json').is_file())
            metadata = json.loads((derived/'.client-data.json').read_text())
            self.assertEqual(metadata['manifest_version'], 2)
            self.assertEqual(metadata['source_version'], proof['source_version'])
            self.assertTrue(all(len(file['sha256']) == 64 for file in metadata['files']))
            self.assertEqual(repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full)), manifest)

    def test_unrecognized_original_bytes_fail_before_derivation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, full, proof = self.setup_source(root)
            (source/'patch.MPQ').write_bytes(b'other private input')
            derived = root/'derived/Data'
            with self.assertRaisesRegex(RuntimeError, 'archive'):
                repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            self.assertFalse(derived.exists())

    def test_source_and_derived_paths_must_be_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, full, proof = self.setup_source(Path(tmp))
            with self.assertRaises(ValueError):
                repair_client.repair(source, source, _proof=proof, tool=FixtureMpq(full))

    def test_extra_original_mpq_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            source, full, proof = self.setup_source(Path(tmp))
            (source/'unknown.MPQ').write_bytes(b'unrecognized overlay')
            with self.assertRaisesRegex(RuntimeError, 'inventory'):
                repair_client.repair(source, Path(tmp)/'derived/Data', _proof=proof, tool=FixtureMpq(full))

    def test_legacy_normalized_manifest_upgrades_only_after_content_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, full, proof = self.setup_source(root)
            derived = root/'derived/Data'
            repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            marker = derived/'.client-data.json'
            old = json.loads(marker.read_text())
            old.pop('manifest_version', None)
            old.pop('source_version', None)
            for entry in old['files']:
                entry.pop('sha256', None)
            marker.write_text(json.dumps(old))
            before = {p.name:p.read_bytes() for p in derived.glob('*.MPQ')}
            repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            self.assertEqual(before, {p.name:p.read_bytes() for p in derived.glob('*.MPQ')})
            self.assertEqual(json.loads(marker.read_text())['manifest_version'], 2)

    def test_extra_derived_mpq_is_rejected_even_if_unlisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, full, proof = self.setup_source(root)
            derived = root/'derived/Data'
            repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            (derived/'unknown.MPQ').write_bytes(b'unrecognized overlay')
            with self.assertRaisesRegex(RuntimeError, 'Derived'):
                repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))

    def test_restart_rejects_same_size_derived_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, full, proof = self.setup_source(root)
            derived = root/'derived/Data'
            repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            model = derived/'model.MPQ'
            length = model.stat().st_size
            model.unlink()
            model.write_bytes(b'x'*length)
            with self.assertRaisesRegex(RuntimeError, 'Derived'):
                repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))

    def test_marker_cannot_bless_modified_overlay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, full, proof = self.setup_source(root)
            derived = root/'derived/Data'
            repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
            patch = derived/'patch-2.MPQ'
            original = patch.read_bytes()
            patch.unlink()
            patch.write_bytes(b'x'+original[1:])
            marker = derived/'.client-data.json'
            metadata = json.loads(marker.read_text())
            changed = hashlib.sha256(patch.read_bytes()).hexdigest()
            metadata['repair']['overlay_sha256'] = changed
            for entry in metadata['files']:
                if entry['name'] == 'patch-2.MPQ':
                    entry['sha256'] = changed
            marker.write_text(json.dumps(metadata))
            with self.assertRaisesRegex(RuntimeError, 'Derived'):
                repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))

    def test_empty_duplicate_path_or_unknown_version_marker_is_rejected(self):
        for mutation in ('empty', 'duplicate', 'relative', 'absolute', 'version'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                source, full, proof = self.setup_source(root)
                derived = root/'derived/Data'
                repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))
                marker = derived/'.client-data.json'
                metadata = json.loads(marker.read_text())
                if mutation == 'empty':
                    metadata['files'] = []
                elif mutation == 'duplicate':
                    metadata['files'].append(metadata['files'][0])
                elif mutation == 'relative':
                    metadata['files'][0]['name'] = '../Data/'+metadata['files'][0]['name']
                elif mutation == 'absolute':
                    metadata['files'][0]['name'] = str(derived/metadata['files'][0]['name'])
                else:
                    metadata['manifest_version'] = 99
                marker.write_text(json.dumps(metadata))
                with self.assertRaisesRegex(RuntimeError, 'Derived'):
                    repair_client.repair(source, derived, _proof=proof, tool=FixtureMpq(full))


if __name__ == '__main__':
    unittest.main()
