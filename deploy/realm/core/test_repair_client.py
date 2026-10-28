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
        proof = dict(entry='World/Maps/Kalimdor/Kalimdor_33_49.adt',
                     prefix_size=len(full)//2, restored_size=len(full),
                     prefix_sha256=hashlib.sha256(full[:len(full)//2]).hexdigest(),
                     restored_sha256=hashlib.sha256(full).hexdigest(),
                     archives={name: dict(size=(source/name).stat().st_size,
                                          sha256=hashlib.sha256((source/name).read_bytes()).hexdigest())
                               for name in ['patch.MPQ', 'patch-2.MPQ', 'terrain.MPQ']})
        return source, full, proof

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


if __name__ == '__main__':
    unittest.main()
