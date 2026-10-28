import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('export_image', Path(__file__).parents[1] / 'tools/export-image.py')
export_image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export_image)


class ImageExportTests(unittest.TestCase):
    def fixture(self, root):
        for name in ('opt/mangos/bin/mangosd', 'opt/mangos/bin/realmd', 'lib/libfixture.so',
                     'opt/railway-core/source/cmangos-bridge-source.tar.gz', 'opt/railway-core/runtime.py',
                     'opt/railway-core/adt_repair.py', 'opt/railway-core/repair_client.py',
                     'opt/railway-core/smoke_runtime.py', 'opt/mangos/etc/mangosd.conf.dist',
                     'config/private.conf', 'realm-data/client/Data/private.MPQ'):
            path = Path(root) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(name.encode())

    def test_only_approved_code_is_exported_with_exact_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root)
            output = io.BytesIO()
            expected = export_image.export_bundle(root, {'/lib/libfixture.so'}, 'a' * 40, 'sha256:' + 'b' * 64, output)
            with tarfile.open(fileobj=io.BytesIO(output.getvalue()), mode='r:gz') as archive:
                actual = json.load(archive.extractfile('manifest.json'))
                self.assertEqual(actual, expected)
                names = archive.getnames()
                self.assertIn('root/lib/libfixture.so', names)
                self.assertIn('root/opt/mangos/etc/mangosd.conf.dist', names)
                self.assertFalse(any('private' in name for name in names))
                self.assertEqual(actual['files']['root/opt/mangos/bin/mangosd']['size'], len(b'opt/mangos/bin/mangosd'))

    def test_unknown_library_locations_and_source_secrets_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root)
            with self.assertRaises(ValueError):
                export_image.gather(root, {'/config/private.conf'})
            (Path(root) / 'opt/railway-core/source/.env').write_text('must not export')
            with self.assertRaises(ValueError):
                export_image.gather(root, {'/lib/libfixture.so'})

    def test_actual_commit_and_image_identity_are_required(self):
        with tempfile.TemporaryDirectory() as root:
            self.fixture(root)
            with self.assertRaises(ValueError):
                export_image.export_bundle(root, set(), None, None, io.BytesIO())


if __name__ == '__main__':
    unittest.main()
