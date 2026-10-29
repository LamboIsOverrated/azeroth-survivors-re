import importlib.util
import io
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare_data', Path(__file__).parents[1] / 'prepare_data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ArchiveValidation(unittest.TestCase):
    def archive(self, names):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, 'w') as writer:
            for name in names:
                writer.writestr(name, b'candidate MPQ')
        return zipfile.ZipFile(stream)

    def test_required_canaries_and_flat_mpq_paths(self):
        with self.archive(['Data/terrain.MPQ','Data/patch.MPQ','Data/model.MPQ','other.txt']) as archive:
            self.assertEqual(len(module.selected_entries(archive)), 3)

    def test_traversal_and_duplicate_case_fail_closed(self):
        for bad in ['Data/../escape.MPQ', 'Data/nested/escape.MPQ', 'Data/PATCH.MPQ']:
            with self.archive(['Data/terrain.MPQ','Data/patch.MPQ',bad]) as archive:
                with self.assertRaises(ValueError):
                    module.selected_entries(archive)

    def test_incomplete_install_is_not_ready(self):
        with self.archive(['Data/terrain.MPQ']) as archive:
            with self.assertRaises(ValueError):
                module.selected_entries(archive)


if __name__ == '__main__':
    unittest.main()
