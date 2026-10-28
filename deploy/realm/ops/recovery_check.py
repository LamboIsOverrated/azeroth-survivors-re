#!/usr/bin/env python3
"""Check restored web keys and make authenticated private recovery envelopes."""
import argparse
import contextlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
import sys
import uuid

import realm_backup as backup

MAGIC = b'REALM-RECOVERY-AES256GCM-v1\n'
CHUNK = 1024 * 1024


def check_web(state):
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
    state = Path(state).resolve()
    key_path = state / 'master.key'
    backup.require(key_path.is_file() and not key_path.is_symlink(), 'recovered master key missing or unsafe')
    raw = key_path.read_bytes()
    backup.validate_key(raw)
    cipher = ChaCha20Poly1305(bytes.fromhex(raw.decode().strip()))
    result = {'sqlite_integrity': True}
    for name in ('realm.sqlite', 'economy.sqlite'):
        path = state / name
        backup.require(path.is_file() and not path.is_symlink(), 'recovered SQLite state missing or unsafe')
        with contextlib.closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
            backup.require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'recovered SQLite integrity failed')
            if name == 'economy.sqlite':
                result['test_journal_entries'], units = db.execute('SELECT COUNT(*), COALESCE(SUM(delta),0) FROM journal').fetchone()
                result['test_journal_net_units'] = str(units)
            else:
                rows = db.execute('SELECT password_enc, nonce FROM game_accounts').fetchall()
                backup.require(bool(rows), 'no recovered game credentials available for a decryption proof')
                try:
                    for encrypted, nonce in rows:
                        plaintext = cipher.decrypt(bytes(nonce), bytes(encrypted), None)
                        backup.require(0 < len(plaintext) <= 16 and plaintext.isascii(), 'invalid recovered game credential')
                        del plaintext
                    meta = dict(db.execute("SELECT key,value FROM meta WHERE key IN ('soap_pass_enc','soap_nonce')"))
                    backup.require(not meta or set(meta) == {'soap_pass_enc', 'soap_nonce'}, 'incomplete recovered SOAP credential')
                    if meta:
                        plaintext = cipher.decrypt(bytes.fromhex(meta['soap_nonce']), bytes.fromhex(meta['soap_pass_enc']), None)
                        backup.require(bool(plaintext), 'empty recovered SOAP credential')
                        del plaintext
                except (InvalidTag, ValueError, TypeError):
                    raise backup.BackupError('recovered key does not authenticate stored credentials') from None
                result['game_credentials_decrypted'] = len(rows)
                result['soap_credentials_decrypted'] = bool(meta)
                result['web_users'] = db.execute('SELECT COUNT(*) FROM users').fetchone()[0]
    return result


def load_key(path, *, create=False):
    path = backup.outside_git(Path(path))
    backup.require(path.parent.is_dir(), 'key parent directory must exist')
    if create and not path.exists():
        with backup.private_file(path) as target:
            target.write(secrets.token_bytes(32))
    backup.require(path.is_file(), 'recovery-envelope key is missing')
    backup.restrict_private(path)
    key = path.read_bytes()
    backup.require(len(key) == 32, 'invalid recovery-envelope key')
    return key


def publish(path, writer):
    path = backup.outside_git(Path(path))
    backup.require(path.parent.is_dir() and not path.exists(), 'recovery output must be new with an existing parent')
    temporary = path.with_name(path.name + '.partial-' + uuid.uuid4().hex)
    try:
        with backup.private_file(temporary) as target:
            writer(target)
            target.flush()
            os.fsync(target.fileno())
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def seal(source, destination, key_path):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    source, destination, key_path = Path(source).resolve(), Path(destination), Path(key_path)
    backup.require(source.is_file() and not source.is_symlink(), 'recovery source is missing or unsafe')
    backup.require(key_path.resolve().parent != destination.resolve().parent,
                   'store the encryption key separately from the encrypted recovery copy')
    key = load_key(key_path, create=True)
    nonce = secrets.token_bytes(12)
    encryptor = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
    encryptor.authenticate_additional_data(MAGIC)
    def write(target):
        target.write(MAGIC + nonce)
        with source.open('rb') as original:
            for chunk in iter(lambda: original.read(CHUNK), b''):
                target.write(encryptor.update(chunk))
        target.write(encryptor.finalize())
        target.write(encryptor.tag)
    publish(destination, write)
    return {'source_sha256': backup.digest_file(source), 'envelope_sha256': backup.digest_file(destination),
            'encryption': 'AES-256-GCM', 'authenticated': True}


def open_envelope(source, destination, key_path):
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    key = load_key(key_path)
    source = Path(source)
    with source.open('rb') as original:
        backup.require(original.read(len(MAGIC)) == MAGIC, 'unknown recovery envelope format')
        nonce = original.read(12)
        size = source.stat().st_size - len(MAGIC) - 12 - 16
        backup.require(len(nonce) == 12 and size >= 0, 'truncated recovery envelope')
        original.seek(-16, os.SEEK_END)
        tag = original.read(16)
        original.seek(len(MAGIC) + 12)
        decryptor = Cipher(algorithms.AES(key), modes.GCM(nonce, tag)).decryptor()
        decryptor.authenticate_additional_data(MAGIC)
        def write(target):
            remaining = size
            while remaining:
                data = original.read(min(CHUNK, remaining))
                backup.require(bool(data), 'truncated recovery envelope')
                remaining -= len(data)
                target.write(decryptor.update(data))
            try:
                target.write(decryptor.finalize())
            except InvalidTag:
                raise backup.BackupError('recovery envelope authentication failed') from None
        publish(destination, write)
    return {'recovered_sha256': backup.digest_file(Path(destination)), 'authenticated': True}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    check = commands.add_parser('check-web', help='verify recovered SQLite files and credential decryption without disclosing credentials')
    check.add_argument('--state', required=True)
    for name in ('seal', 'open'):
        command = commands.add_parser(name)
        for option in ('source', 'output', 'key-file'):
            command.add_argument('--' + option, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'check-web':
            result = check_web(args.state)
        elif args.command == 'seal':
            result = seal(args.source, args.output, args.key_file)
        else:
            result = open_envelope(args.source, args.output, args.key_file)
        print(json.dumps(result, sort_keys=True))
    except (backup.BackupError, OSError, ValueError, sqlite3.Error, ImportError) as error:
        print('Recovery check refused or failed: ' + (str(error) if isinstance(error, backup.BackupError) else type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
