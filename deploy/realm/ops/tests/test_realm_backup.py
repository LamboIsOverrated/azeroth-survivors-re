import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / 'realm_backup.py'
spec = importlib.util.spec_from_file_location('realm_backup', MODULE)
backup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = backup
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = self.root / 'payload'
        (self.payload / 'web').mkdir(parents=True)
        (self.payload / 'core/config').mkdir(parents=True)
        for name in ('realm.sqlite', 'economy.sqlite'):
            with contextlib.closing(sqlite3.connect(self.payload / 'web' / name)) as db:
                db.execute('CREATE TABLE fixture (value TEXT)')
                db.execute("INSERT INTO fixture VALUES ('kept')")
                db.commit()
        (self.payload / 'web/master.key').write_text('ab' * 32)
        (self.payload / 'core/realm.sql').write_bytes(b'-- logical SQL fixture\n')
        (self.payload / 'core/config/mangosd.conf').write_text('GameType = 1\n')
        (self.payload / 'core/config/realmd.conf').write_text('RealmServerPort = 3724\n')
        self.archive = self.root / 'backup.tar.gz'
        self.metadata = {'snapshot_id': 'fixture-1', 'source': {'project': 'p', 'environment': 'e'},
                         'quiesced': True, 'schemas': list(backup.SCHEMAS)}

    def package(self):
        backup.package(self.payload, self.archive, self.metadata)

    def rewrite(self, change):
        with tarfile.open(self.archive, 'r:gz') as src:
            members = [(m.name, src.extractfile(m).read()) for m in src.getmembers()]
        with tarfile.open(self.archive, 'w:gz') as dst:
            for name, data in change(members):
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                dst.addfile(entry, io.BytesIO(data))

    def test_round_trip_is_private_and_restores_committed_sqlite_values(self):
        self.package()
        manifest = backup.verify(self.archive)
        self.assertEqual(manifest['schemas'], ['classicrealmd', 'classiccharacters', 'classicmangos', 'classiclogs'])
        destination = self.root / 'realm-restore-drill'
        backup.unpack(self.archive, destination)
        with contextlib.closing(sqlite3.connect(destination / 'web/realm.sqlite')) as db:
            self.assertEqual(db.execute('SELECT value FROM fixture').fetchall(), [('kept',)])
        self.assertEqual((destination / 'web/master.key').read_text(), 'ab' * 32)
        if os.name == 'posix':
            self.assertEqual(self.archive.stat().st_mode & 0o777, 0o600)
            self.assertEqual((destination / 'web/master.key').stat().st_mode & 0o777, 0o600)

    def test_missing_key_never_publishes_completed_archive(self):
        (self.payload / 'web/master.key').unlink()
        with self.assertRaises(backup.BackupError):
            self.package()
        self.assertFalse(self.archive.exists())
        self.assertEqual(list(self.root.glob('*.partial*')), [])

    def test_invalid_key_is_rejected(self):
        for key in ('not-a-master-key', ' '.join(['ab'] * 32)):
            (self.payload / 'web/master.key').write_text(key)
            with self.assertRaises(backup.BackupError):
                self.package()

    def test_payload_symlink_is_rejected(self):
        try:
            (self.payload / 'core/config/link').symlink_to(self.payload / 'web/master.key')
        except OSError:
            self.skipTest('symlinks unavailable')
        with self.assertRaises(backup.BackupError):
            self.package()

    def test_hash_mismatch_rejected_before_destination_is_created(self):
        self.package()
        self.rewrite(lambda members: [(n, b'tampered' if n == 'core/realm.sql' else d) for n, d in members])
        destination = self.root / 'realm-restore-bad'
        with self.assertRaises(backup.BackupError):
            backup.unpack(self.archive, destination)
        self.assertFalse(destination.exists())

    def test_traversal_absolute_windows_and_duplicate_members_rejected(self):
        for unsafe in ('../escaped', '/state/master.key', 'C:/state/key', 'web\\..\\escaped', 'web/realm.sqlite'):
            with self.subTest(name=unsafe):
                self.archive.unlink(missing_ok=True)
                self.package()
                self.rewrite(lambda members: members + [(unsafe, b'escape')])
                with self.assertRaises(backup.BackupError):
                    backup.verify(self.archive)
        self.assertFalse((self.root / 'escaped').exists())

    def test_extra_unmanifested_file_and_omitted_key_rejected(self):
        self.package()
        self.rewrite(lambda members: members + [('web/unlisted', b'x')])
        with self.assertRaises(backup.BackupError):
            backup.verify(self.archive)
        self.archive.unlink()
        self.package()
        self.rewrite(lambda members: [(n, d) for n, d in members if n != 'web/master.key'])
        with self.assertRaises(backup.BackupError):
            backup.verify(self.archive)

    def test_no_overwrite_and_failed_archive_write_is_atomic(self):
        self.archive.write_bytes(b'previous-backup')
        with self.assertRaises(backup.BackupError):
            self.package()
        self.assertEqual(self.archive.read_bytes(), b'previous-backup')
        self.archive.unlink()
        (self.payload / 'core/realm.sql').write_bytes(b'')
        with self.assertRaises(backup.BackupError):
            self.package()
        self.assertFalse(self.archive.exists())

    def test_interrupted_archive_write_removes_partial_and_never_publishes(self):
        original = tarfile.TarFile.addfile
        calls = 0
        def disk_failure(archive, *args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('fixture disk full')
            return original(archive, *args, **kwargs)
        with mock.patch.object(tarfile.TarFile, 'addfile', disk_failure):
            with self.assertRaises(OSError):
                self.package()
        self.assertFalse(self.archive.exists())
        self.assertEqual(list(self.root.glob('*.partial-*')), [])

    def test_private_output_inside_git_is_refused(self):
        (self.root / '.git').mkdir()
        with self.assertRaises(backup.BackupError):
            self.package()
        self.assertFalse(self.archive.exists())

    def test_subprocess_failure_does_not_echo_private_diagnostics(self):
        with self.assertRaises(backup.BackupError) as failure:
            backup.run([sys.executable, '-c', 'import sys; sys.stderr.write("fixture-private-password"); sys.exit(1)'])
        self.assertNotIn('fixture-private-password', str(failure.exception))

    def test_restore_requires_new_explicit_scratch_destination(self):
        self.package()
        for destination in (self.root / 'ordinary-directory', Path('/state'), self.payload,
                            Path('realm-restore-relative')):
            with self.subTest(destination=str(destination)):
                with self.assertRaises(backup.BackupError):
                    backup.unpack(self.archive, destination)
        destination = self.root / 'realm-restore-existing'
        destination.mkdir()
        with self.assertRaises(backup.BackupError):
            backup.unpack(self.archive, destination)

    def test_restore_cannot_write_scratch_beneath_runtime_state_paths(self):
        self.package()
        for name in ('state', 'realm-data'):
            parent = self.root / name
            parent.mkdir()
            destination = parent / 'realm-restore-dangerous'
            with self.assertRaises(backup.BackupError):
                backup.unpack(self.archive, destination)
            self.assertFalse(destination.exists())

    def test_sqlite_online_backup_includes_wal_and_never_changes_source(self):
        source = self.root / 'active.sqlite'
        db = sqlite3.connect(source)
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE data (value INTEGER)')
        db.execute('INSERT INTO data VALUES (42)')
        db.commit()
        destination = self.root / 'snapshot.sqlite'
        backup.sqlite_snapshot(source, destination)
        with contextlib.closing(sqlite3.connect(destination)) as result:
            self.assertEqual(result.execute('SELECT value FROM data').fetchall(), [(42,)])
        self.assertEqual(db.execute('SELECT value FROM data').fetchall(), [(42,)])

    def test_sql_restore_refuses_default_port_nonlocal_target_or_existing_schema(self):
        for host, port, user in [('realm-db.railway.internal', 3307, 'root'), ('127.0.0.1', 3306, 'root'),
                                 ('localhost;evil', 3307, 'root')]:
            with self.subTest(host=host, port=port):
                with self.assertRaises(backup.BackupError):
                    backup.restore_connection(host, port, user, 'RESTORE_DB_PASSWORD')
        command, env = backup.restore_connection('127.0.0.1', 13307, 'root', 'RESTORE_DB_PASSWORD', {'RESTORE_DB_PASSWORD': 'secret-fixture'})
        self.assertNotIn('secret-fixture', ' '.join(command))
        self.assertEqual(env['MYSQL_PWD'], 'secret-fixture')
        with self.assertRaises(backup.BackupError):
            backup.assert_empty_schemas('classiccharacters\n')
        backup.assert_empty_schemas('information_schema\nmysql\nperformance_schema\nsys\n')

    def test_active_or_paused_writers_refused(self):
        proc = self.root / 'proc'
        entry = proc / '99999999'
        entry.mkdir(parents=True)
        (entry / 'stat').write_text('99999999 (node) S 1 2 3')
        for args in (b'node\0/app/deploy/realm/web/runtime.mjs\0',
                     b'python3\0/opt/railway-core/runtime.py\0serve\0', b'/opt/mangos/bin/ad\0'):
            (entry / 'cmdline').write_bytes(args)
            with self.assertRaises(backup.BackupError):
                backup.assert_quiesced(proc)
        (entry / 'stat').write_text('99999999 (node) T 1 2 3')
        with self.assertRaises(backup.BackupError):
            backup.assert_quiesced(proc)

    def test_only_exact_maintenance_wrappers_allowed(self):
        proc = self.root / 'proc'
        entry = proc / '99999999'
        entry.mkdir(parents=True)
        (entry / 'stat').write_text('99999999 (node) S 1 2 3')
        (entry / 'cmdline').write_bytes(b'node\0/app/deploy/realm/web/runtime.mjs\0')
        backup.assert_quiesced(proc, maintenance=True, role='web')
        with self.assertRaises(backup.BackupError):
            backup.assert_quiesced(proc, maintenance=True, role='core')
        (entry / 'cmdline').write_bytes(b'node\0/app/other.mjs\0')
        with self.assertRaises(backup.BackupError):
            backup.assert_quiesced(proc, maintenance=True, role='web')
        (entry / 'cmdline').write_bytes(b'python3\0/opt/railway-core/runtime.py\0serve\0')
        backup.assert_quiesced(proc, maintenance=True, role='core')

    def test_archive_cannot_include_links(self):
        self.package()
        with tarfile.open(self.archive, 'r:gz') as src:
            members = [(m, src.extractfile(m).read()) for m in src.getmembers()]
        with tarfile.open(self.archive, 'w:gz') as dst:
            for entry, data in members:
                dst.addfile(entry, io.BytesIO(data))
            link = tarfile.TarInfo('core/config/evil.conf')
            link.type = tarfile.SYMTYPE
            link.linkname = '/state/master.key'
            dst.addfile(link)
        with self.assertRaises(backup.BackupError):
            backup.verify(self.archive)

    def test_extraction_rechecks_member_content_before_publishing(self):
        self.package()
        original = backup.verify
        def change_after_verify(path):
            manifest = original(path)
            self.rewrite(lambda members: [(n, b'tampered' if n == 'core/realm.sql' else d) for n, d in members])
            return manifest
        destination = self.root / 'realm-restore-swapped'
        with mock.patch.object(backup, 'verify', side_effect=change_after_verify):
            with self.assertRaises(backup.BackupError):
                backup.unpack(self.archive, destination)
        self.assertFalse(destination.exists())

    def test_copy_sql_verifies_hash_before_any_import_can_start(self):
        self.package()
        with tempfile.TemporaryFile('w+b') as output:
            backup.stage_sql(self.archive, output)
            output.seek(0)
            self.assertEqual(output.read(), b'-- logical SQL fixture\n')


if __name__ == '__main__':
    unittest.main()
