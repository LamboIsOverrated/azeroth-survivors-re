"""Integrity checks include the model formats omitted by the first restore copy."""
import json
from pathlib import Path
import tempfile
import unittest

import world_inventory as inventory


class WorldInventoryTests(unittest.TestCase):
    def fixture(self, root):
        data = root / 'data'
        for name in ('dbc/Map.dbc', 'maps/000.map', 'vmaps/000.vmtree',
                     'vmaps/tree.vmo', 'vmaps/tree.m2', 'vmaps/index', 'mmaps/000.mmap'):
            path = data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'accepted bytes')
        rows = inventory.scan_outputs(data)
        profile = {'version': 1, 'core': 'test-core', 'inputs': [], 'tools': {},
                   'outputs': inventory.summary(rows)}
        return data, profile

    def test_complete_tree_can_be_sealed_and_verified(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, profile = self.fixture(root)
            marker = root / 'complete.json'
            inventory.seal_outputs(data, marker, profile)
            inventory.verify_outputs(data, marker, profile)
            self.assertEqual(len(json.loads(marker.read_text())['files']), 7)

    def test_missing_vmo_same_size_corruption_and_extra_files_fail_closed(self):
        for change in ('missing-vmo', 'corrupt-m2', 'extra-file'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                data, profile = self.fixture(root)
                marker = root / 'complete.json'
                inventory.seal_outputs(data, marker, profile)
                if change == 'missing-vmo':
                    (data / 'vmaps/tree.vmo').unlink()
                elif change == 'corrupt-m2':
                    (data / 'vmaps/tree.m2').write_bytes(b'corrupt! bytes')
                else:
                    (data / 'vmaps/extra').write_bytes(b'unknown')
                with self.assertRaisesRegex(RuntimeError, 'inventory'):
                    inventory.verify_outputs(data, marker, profile)
                with self.assertRaisesRegex(RuntimeError, 'inventory'):
                    inventory.seal_outputs(data, marker, profile)

    def test_legacy_or_tampered_marker_cannot_attest_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, profile = self.fixture(root)
            marker = root / 'complete.json'
            marker.write_text('{"core":"test-core"}')
            with self.assertRaisesRegex(RuntimeError, 'manifest'):
                inventory.verify_outputs(data, marker, profile)
            inventory.seal_outputs(data, marker, profile)
            changed = dict(profile, core='other-core')
            with self.assertRaisesRegex(RuntimeError, 'manifest'):
                inventory.verify_outputs(data, marker, changed)
            record = json.loads(marker.read_text())
            record['files'] = record['files'][:-1]
            marker.write_text(json.dumps(record))
            with self.assertRaisesRegex(RuntimeError, 'manifest'):
                inventory.verify_outputs(data, marker, profile)

    def test_source_hashes_reject_changed_inputs_and_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client, tools = root / 'client', root / 'tools'
            (client / 'Data').mkdir(parents=True)
            tools.mkdir()
            archive, extractor = client / 'Data/base.MPQ', tools / 'ad'
            archive.write_bytes(b'original')
            extractor.write_bytes(b'extractor')
            config = root / 'config.json'
            config.write_bytes(b'config')
            profile = {'inputs': [['Data/base.MPQ', 8, inventory.digest(archive)]],
                       'tools': {'ad': inventory.digest(extractor),
                                 '@config': inventory.digest(config)}}
            inventory.verify_sources(client, tools, config, profile)
            archive.write_bytes(b'changed!')
            with self.assertRaisesRegex(RuntimeError, 'input'):
                inventory.verify_sources(client, tools, config, profile)
            archive.write_bytes(b'original')
            extractor.write_bytes(b'changed!!')
            with self.assertRaisesRegex(RuntimeError, 'extractor'):
                inventory.verify_sources(client, tools, config, profile)

    @unittest.skipIf(__import__('os').name == 'nt', 'symlinks require Windows developer privileges')
    def test_input_link_accepts_only_exact_immutable_original_and_still_hashes_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client, tools = root / 'client', root / 'tools'
            (client / 'Data').mkdir(parents=True)
            tools.mkdir()
            originals = root / 'client-original/Data'
            originals.mkdir(parents=True)
            original = originals / 'base.MPQ'
            original.write_bytes(b'accepted')
            linked = client / 'Data/base.MPQ'
            linked.symlink_to(original)
            profile = {'inputs': [['Data/base.MPQ', 8, inventory.digest(original)]], 'tools': {}}
            inventory.verify_sources(client, tools, root / 'unused', profile)
            original.write_bytes(b'changed!')
            with self.assertRaisesRegex(RuntimeError, 'input inventory'):
                inventory.verify_sources(client, tools, root / 'unused', profile)
            linked.unlink()
            other = root / 'other.MPQ'
            other.write_bytes(b'accepted')
            linked.symlink_to(other)
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                inventory.verify_sources(client, tools, root / 'unused', profile)

    @unittest.skipIf(__import__('os').name == 'nt', 'symlinks require Windows developer privileges')
    def test_only_the_audited_patch_can_link_to_the_private_overlay(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            client = root / 'client'
            (client / 'Data').mkdir(parents=True)
            overlay = root / 'client-overlay/patch-2.MPQ'
            overlay.parent.mkdir()
            overlay.write_bytes(b'accepted overlay')
            linked = client / 'Data/patch-2.MPQ'
            linked.symlink_to(overlay)
            profile = {'inputs': [['Data/patch-2.MPQ', overlay.stat().st_size, inventory.digest(overlay)]],
                       'tools': {}}
            inventory.verify_sources(client, root / 'tools', root / 'unused', profile)
            linked.rename(linked.with_name('other.MPQ'))
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                inventory.verify_sources(client, root / 'tools', root / 'unused', profile)

    @unittest.skipIf(__import__('os').name == 'nt', 'symlinks require Windows developer privileges')
    def test_symlinked_model_is_never_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data, _ = self.fixture(root)
            (data / 'vmaps/link.vmo').symlink_to(data / 'vmaps/tree.vmo')
            with self.assertRaisesRegex(RuntimeError, 'symlink'):
                inventory.scan_outputs(data)


if __name__ == '__main__':
    unittest.main()
