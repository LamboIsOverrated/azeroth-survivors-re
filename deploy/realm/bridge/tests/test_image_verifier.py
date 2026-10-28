import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verify_image', Path(__file__).parents[1] / 'tools/verify-image.py')
verify_image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_image)


class ImageSourceTests(unittest.TestCase):
    def fixture(self, root, header=b'reviewed kernel', license=True, revision=verify_image.REVISION):
        source = Path(root) / 'opt/railway-core/source'
        (source / 'bridge/core').mkdir(parents=True)
        patch = b'reviewed source patch'
        (source / 'bridge/core/world-bridge.patch').write_bytes(patch)
        (source / 'bridge/core/pinned-sources.json').write_text(json.dumps({'revision': revision, 'files': {'file': 'hash'}}))
        with tarfile.open(source / 'cmangos-bridge-source.tar.gz', 'w:gz') as archive:
            entries = {'src/shared/Database/WorldBridge.h': header, 'AUTHORS.md': b'upstream authors'}
            if license:
                entries['LICENSE'] = b'upstream license'
            for name, data in entries.items():
                member = tarfile.TarInfo('mangos-classic/' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return hashlib.sha256(b'reviewed kernel').hexdigest(), hashlib.sha256(patch).hexdigest()

    def test_matching_source_package_is_accepted_without_extracting_archive(self):
        with tempfile.TemporaryDirectory() as root:
            verify_image.verify_source(root, *self.fixture(root))

    def test_old_kernel_missing_license_and_wrong_pin_fail_closed(self):
        for changes in ({'header': b'old kernel'}, {'license': False}, {'revision': 'different'}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as root:
                expected = self.fixture(root, **changes)
                with self.assertRaises((ValueError, KeyError)):
                    verify_image.verify_source(root, *expected)

    def test_missing_or_modified_expected_patch_is_not_silently_accepted(self):
        with tempfile.TemporaryDirectory() as root:
            header, patch = self.fixture(root)
            for changed in (None, '0' * 64):
                with self.assertRaises(ValueError):
                    verify_image.verify_source(root, header, changed)


if __name__ == '__main__':
    unittest.main()
