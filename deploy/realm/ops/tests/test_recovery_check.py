import contextlib
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import realm_backup as backup
import recovery_check as recovery
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305


class RecoveryChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'recovered'
        self.state.mkdir()
        key = bytes.fromhex('ab' * 32)
        (self.state / 'master.key').write_text(key.hex())
        with contextlib.closing(sqlite3.connect(self.state / 'realm.sqlite')) as db:
            db.executescript('CREATE TABLE users (id INTEGER); INSERT INTO users VALUES (1);'
                             'CREATE TABLE game_accounts (password_enc BLOB, nonce BLOB);'
                             'CREATE TABLE meta (key TEXT, value TEXT);')
            nonce = bytes.fromhex('cd' * 12)
            ciphertext = ChaCha20Poly1305(key).encrypt(nonce, b'fixture-password', None)
            db.execute('INSERT INTO game_accounts VALUES (?,?)', (ciphertext, nonce))
            db.commit()
        with contextlib.closing(sqlite3.connect(self.state / 'economy.sqlite')) as db:
            db.executescript('CREATE TABLE journal (delta INTEGER); INSERT INTO journal VALUES (42);')

    def test_recovered_key_decrypts_credentials_without_returning_plaintext(self):
        result = recovery.check_web(self.state)
        self.assertEqual(result['game_credentials_decrypted'], 1)
        self.assertEqual(result['test_journal_net_units'], '42')
        self.assertNotIn('fixture-password', str(result))
        self.assertTrue(result['sqlite_integrity'])

    def test_wrong_key_and_no_game_accounts_fail_closed(self):
        (self.state / 'master.key').write_text('12' * 32)
        with self.assertRaises(backup.BackupError) as error:
            recovery.check_web(self.state)
        self.assertNotIn('fixture-password', str(error.exception))
        (self.state / 'master.key').write_text('ab' * 32)
        with contextlib.closing(sqlite3.connect(self.state / 'realm.sqlite')) as db:
            db.execute('DELETE FROM game_accounts')
            db.commit()
        with self.assertRaises(backup.BackupError):
            recovery.check_web(self.state)

    def test_encrypted_copy_authenticates_before_publishing_recovered_bytes(self):
        source = self.root / 'fixture.tar.gz'
        source.write_bytes(b'private-fixture\0' * 100000)
        keys = self.root / 'keys'
        keys.mkdir()
        key = keys / 'backup.key'
        encrypted = self.root / 'fixture.encrypted'
        sealed = recovery.seal(source, encrypted, key)
        self.assertEqual(sealed['source_sha256'], backup.digest_file(source))
        restored = self.root / 'restored.tar.gz'
        recovery.open_envelope(encrypted, restored, key)
        self.assertEqual(restored.read_bytes(), source.read_bytes())
        corrupted = bytearray(encrypted.read_bytes())
        corrupted[-25] ^= 1
        encrypted.write_bytes(corrupted)
        failed = self.root / 'must-not-exist.tar.gz'
        with self.assertRaises(backup.BackupError):
            recovery.open_envelope(encrypted, failed, key)
        self.assertFalse(failed.exists())
        self.assertEqual(list(self.root.glob('*.partial-*')), [])

    def test_envelope_and_key_never_overwrite_and_key_is_separate(self):
        source = self.root / 'source'
        source.write_bytes(b'fixture')
        encrypted = self.root / 'copy.encrypted'
        with self.assertRaises(backup.BackupError):
            recovery.seal(source, encrypted, self.root / 'same-directory.key')
        key = self.root / 'keys/key'
        key.parent.mkdir()
        recovery.seal(source, encrypted, key)
        prior = encrypted.read_bytes()
        with self.assertRaises(backup.BackupError):
            recovery.seal(source, encrypted, key)
        self.assertEqual(encrypted.read_bytes(), prior)
        key.write_bytes(b'invalid')
        with self.assertRaises(backup.BackupError):
            recovery.open_envelope(encrypted, self.root / 'invalid-output', key)


if __name__ == '__main__':
    unittest.main()
