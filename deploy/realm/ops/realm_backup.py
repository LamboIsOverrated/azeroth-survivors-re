#!/usr/bin/env python3
"""Private, quiesced realm snapshots and isolated restore drills (Python stdlib)."""
import argparse
import contextlib
import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import urllib.error
import urllib.request

SCHEMAS = ('classicrealmd', 'classiccharacters', 'classicmangos', 'classiclogs')
REQUIRED = {'web/realm.sqlite', 'web/economy.sqlite', 'web/master.key',
            'core/realm.sql', 'core/config/mangosd.conf', 'core/config/realmd.conf'}
FORMAT = 1
MAX_MEMBER = 16 * 1024**3
MAX_TOTAL = 32 * 1024**3
FENCE = 'REALM_WRITERS_STOPPED_AND_WORLD_SAVED'


class BackupError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise BackupError(message)


def private_file(path, mode='wb'):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        restrict_private(Path(path))
        return os.fdopen(descriptor, mode)
    except BaseException:
        os.close(descriptor)
        Path(path).unlink(missing_ok=True)
        raise


def restrict_private(path):
    if os.name != 'nt':
        path.chmod(0o700 if path.is_dir() else 0o600)
        return
    # Apply an owner-rights DACL before any private bytes are written. Unlike chmod,
    # this removes inherited Windows group/read permissions. No external ACL tools.
    import ctypes
    from ctypes import wintypes
    api = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    convert = api.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    convert.restype = wintypes.BOOL
    apply = api.SetFileSecurityW
    apply.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p]
    apply.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    security = ctypes.c_void_p()
    require(convert('D:P(A;OICI;FA;;;OW)' if path.is_dir() else 'D:P(A;;FA;;;OW)', 1, ctypes.byref(security), None),
            'could not create private Windows permissions')
    try:
        require(apply(str(path), 0x80000004, security), 'could not enforce private Windows permissions')
    finally:
        kernel.LocalFree(security)


def outside_git(path):
    require(path.is_absolute(), 'an absolute local path is required')
    require(not path.is_symlink(), 'symlink destination refused')
    path = path.resolve()
    require(not any((p / '.git').exists() for p in (path, *path.parents)),
            'private backup/restore output must be outside a Git checkout')
    return path


def member_name(name):
    require(isinstance(name, str) and name and '\\' not in name and ':' not in name,
            'unsafe archive member name')
    path = PurePosixPath(name)
    require(not path.is_absolute() and all(p not in ('', '.', '..') for p in name.split('/')),
            'unsafe archive member name')
    return name


def allowed_member(name):
    member_name(name)
    return (name in REQUIRED or name in {'core/upstreams.env', 'core/extraction-complete.json',
                                        'web/capture.json', 'core/capture.json'} or
            re.fullmatch(r'core/config/[A-Za-z0-9_.-]+\.conf', name) is not None)


def digest_file(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(data)
    return digest.hexdigest()


def validate_key(data):
    try:
        require(re.fullmatch(r'[A-Fa-f0-9]{64}', data.decode('ascii').strip()) is not None,
                'missing or invalid master key')
    except (UnicodeError, ValueError):
        raise BackupError('missing or invalid master key') from None


def sqlite_snapshot(source, destination):
    require(source.is_file() and not source.is_symlink(), 'SQLite source is missing or unsafe')
    require(not destination.exists(), 'SQLite destination already exists')
    deadline = time.monotonic() + 30
    def progress(status, remaining, total):
        require(time.monotonic() < deadline, 'SQLite snapshot timed out; check paused write transactions')
    try:
        with private_file(destination):
            pass
        with contextlib.closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as src:
            with contextlib.closing(sqlite3.connect(destination)) as dst:
                src.backup(dst, pages=256, progress=progress, sleep=0.05)
                require(dst.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'SQLite integrity check failed')
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def package(payload, output, metadata):
    output = outside_git(Path(output))
    require(output.parent.is_dir() and not output.exists(), 'output parent must exist and output must be new')
    require(metadata.get('quiesced') is True and tuple(metadata.get('schemas', [])) == SCHEMAS,
            'all schemas and explicit quiescence evidence are required')
    files = {}
    for path in sorted(Path(payload).rglob('*')):
        require(not path.is_symlink(), 'symlinks are forbidden in backups')
        if path.is_dir():
            continue
        name = path.relative_to(payload).as_posix()
        require(path.is_file() and allowed_member(name), 'unexpected backup payload')
        size = path.stat().st_size
        require(0 < size <= MAX_MEMBER, 'empty or oversized backup payload')
        files[name] = {'size': size, 'sha256': digest_file(path)}
    require(REQUIRED <= files.keys(), 'backup lacks a required database, key or configuration')
    validate_key((Path(payload) / 'web/master.key').read_bytes())
    manifest = dict(metadata, format=FORMAT, created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(), files=files)
    temporary = output.with_name(output.name + '.partial-' + uuid.uuid4().hex)
    try:
        with private_file(temporary) as stream:
            with tarfile.open(fileobj=stream, mode='w:gz', format=tarfile.PAX_FORMAT) as archive:
                for name in files:
                    entry = archive.gettarinfo(str(Path(payload) / name), arcname=name)
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    entry.mode = 0o600
                    with (Path(payload) / name).open('rb') as src:
                        archive.addfile(entry, src)
                data = json.dumps(manifest, sort_keys=True, indent=2).encode()
                entry = tarfile.TarInfo('manifest.json')
                entry.size, entry.mode = len(data), 0o600
                archive.addfile(entry, io.BytesIO(data))
            stream.flush()
            os.fsync(stream.fileno())
        verify(temporary)
        # Hard-link publication never replaces another backup, even with a concurrent writer.
        os.link(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return manifest


def verify(archive_path):
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            members = {}
            total = 0
            for entry in archive:
                member_name(entry.name)
                require(entry.name not in members and entry.isfile(), 'duplicate or non-file archive member')
                require(0 < entry.size <= MAX_MEMBER, 'empty or oversized archive member')
                total += entry.size
                require(total <= MAX_TOTAL and len(members) < 1000, 'archive exceeds limits')
                require(entry.name == 'manifest.json' or allowed_member(entry.name), 'unexpected archive member')
                members[entry.name] = entry
            require('manifest.json' in members and members['manifest.json'].size < 1024**2, 'missing or oversized manifest')
            manifest = json.load(archive.extractfile(members['manifest.json']))
            require(manifest.get('format') == FORMAT and manifest.get('quiesced') is True,
                    'unsupported or unquiesced backup')
            require(tuple(manifest.get('schemas', [])) == SCHEMAS, 'backup must include all four schemas')
            files = manifest.get('files')
            require(isinstance(files, dict) and REQUIRED <= files.keys(), 'manifest lacks required state/key/config')
            require(set(members) == set(files) | {'manifest.json'}, 'manifest/archive membership mismatch')
            for name, details in files.items():
                require(isinstance(details, dict) and details.get('size') == members[name].size, 'file size mismatch')
                digest = hashlib.sha256()
                with archive.extractfile(members[name]) as src:
                    for data in iter(lambda: src.read(1024 * 1024), b''):
                        digest.update(data)
                require(digest.hexdigest() == details.get('sha256'), 'file hash mismatch')
            validate_key(archive.extractfile(members['web/master.key']).read())
            return manifest
    except (tarfile.TarError, OSError, ValueError, TypeError, KeyError, AttributeError):
        raise BackupError('backup archive is invalid or unreadable') from None


def unpack(archive_path, destination):
    destination = outside_git(Path(destination))
    require(not ({p.casefold() for p in destination.parts} & {'state', 'realm-data'}) and
            '/var/lib/mysql/' not in destination.as_posix().casefold() + '/',
            'restore cannot target a runtime state volume or a directory beneath one')
    require(destination.name.startswith('realm-restore-') and not destination.exists() and destination.parent.is_dir(),
            'restore requires a new absolute realm-restore-* scratch directory')
    manifest = verify(archive_path)
    temporary = Path(tempfile.mkdtemp(prefix='.realm-restore-partial-', dir=destination.parent))
    restrict_private(temporary)
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            seen = set()
            for entry in archive:
                member_name(entry.name)
                require(entry.isfile() and entry.name not in seen, 'archive changed during extraction')
                seen.add(entry.name)
                require(entry.name == 'manifest.json' or entry.name in manifest['files'], 'unexpected extraction member')
                target = temporary / entry.name
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with private_file(target) as dst, archive.extractfile(entry) as src:
                    if entry.name == 'manifest.json':
                        require(entry.size < 1024**2 and json.load(src) == manifest, 'manifest changed during extraction')
                        dst.write(json.dumps(manifest, sort_keys=True).encode())
                    else:
                        copy_checked(src, dst, entry.size, manifest['files'][entry.name])
            require(seen == set(manifest['files']) | {'manifest.json'}, 'archive changed during extraction')
        for name in ('realm.sqlite', 'economy.sqlite'):
            with contextlib.closing(sqlite3.connect((temporary / 'web' / name).as_uri() + '?mode=ro', uri=True)) as db:
                require(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], 'restored SQLite integrity failed')
        # rename refuses an existing nonempty destination; recheck forbids even an empty one.
        require(not destination.exists(), 'restore destination appeared during extraction')
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return manifest


def copy_checked(source, destination, size, expected):
    require(size == expected['size'], 'file changed after verification')
    digest = hashlib.sha256()
    actual_size = 0
    for data in iter(lambda: source.read(1024 * 1024), b''):
        actual_size += len(data)
        require(actual_size <= size, 'file grew during extraction')
        digest.update(data)
        destination.write(data)
    require(actual_size == size and digest.hexdigest() == expected['sha256'], 'file changed after verification')


def stage_sql(archive_path, output):
    manifest = verify(archive_path)
    with tarfile.open(archive_path, 'r:gz') as archive:
        entry = archive.getmember('core/realm.sql')
        require(entry.isfile(), 'SQL member is not a regular file')
        with archive.extractfile(entry) as source:
            copy_checked(source, output, entry.size, manifest['files']['core/realm.sql'])
    output.flush()
    output.seek(0)


def run(command, *, input=None, env=None, stdout=subprocess.PIPE):
    result = subprocess.run(command, input=input, env=env, stdout=stdout, stderr=subprocess.PIPE, check=False)
    # Remote/client diagnostics can contain credentials or private SQL; never echo them.
    require(result.returncode == 0, 'operator subprocess failed; inspect privately (diagnostics suppressed)')
    return result.stdout


def assert_quiesced(proc=Path('/proc'), *, maintenance=False, role=None):
    require(proc.is_dir(), 'remote capture requires Linux process inspection')
    prohibited = {'node', 'wenilla-realm', 'realmd', 'mangosd', 'ad', 'vmap_extractor',
                  'vmap_assembler', 'MoveMapGen', 'mmap-generator', 'mariadb', 'mysql', 'mariadb-dump'}
    for entry in proc.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            args = [a.decode('utf-8', 'replace') for a in args if a]
            command = Path(args[0]).name if args else ''
            writer = command in prohibited or '/opt/railway-core/runtime.py' in args
            if writer:
                state = (entry / 'stat').read_text().rsplit(')', 1)[1].split()[0]
                wrapper = maintenance and (
                    (role == 'web' and command == 'node' and args[1:] == ['/app/deploy/realm/web/runtime.mjs']) or
                    (role == 'core' and command in ('python3', 'python') and
                     args[1:] in (['/opt/railway-core/runtime.py'], ['/opt/railway-core/runtime.py', 'serve'])))
                require(state == 'Z' or wrapper, 'game/account writer or initialization process present; capture refused')
        except (FileNotFoundError, ProcessLookupError):
            continue


def safe_identifier(value):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', value or '') is not None, 'unsafe operator identifier')
    return value


def remote_check(args):
    require(args.confirm_quiesced == FENCE, 'explicit saved-world/write-fence confirmation is required')
    require(os.environ.get('RAILWAY_PROJECT_ID') == args.project and
            os.environ.get('RAILWAY_ENVIRONMENT_ID') == args.environment and
            os.environ.get('RAILWAY_SERVICE_ID') == args.service, 'Railway source identity mismatch')
    require(os.environ.get('REALM_MAINTENANCE') == '1', 'source must explicitly run REALM_MAINTENANCE=1')
    port = int(os.environ.get('PORT', '8080'))
    require(1 <= port <= 65535, 'invalid maintenance health port')
    try:
        try:
            response = urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/healthz', timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            health = json.loads(response.read(65536))
        require(health.get('maintenance') is True and health.get('ready') is False,
                'source health does not confirm maintenance with ready=false')
    except (urllib.error.URLError, ValueError, AttributeError):
        raise BackupError('maintenance health proof unavailable') from None
    assert_quiesced(maintenance=True, role=args.role)


def remote_capture(args):
    remote_check(args)
    snapshot = safe_identifier(args.snapshot_id)
    root = Path('/tmp') / ('realm-capture-' + snapshot + '-' + args.role)
    root.mkdir(mode=0o700)
    try:
        if args.role == 'web':
            state = Path('/state')
            sqlite_snapshot(state / 'realm.sqlite', root / 'realm.sqlite')
            sqlite_snapshot(state / 'economy.sqlite', root / 'economy.sqlite')
            require(not (state / 'master.key').is_symlink(), 'unsafe master key path')
            key = (state / 'master.key').read_bytes()
            validate_key(key)
            with private_file(root / 'master.key') as dst:
                dst.write(key)
        else:
            cfg = Path('/realm-data/config')
            require(cfg.is_dir() and not cfg.is_symlink(), 'missing or unsafe core configuration')
            (root / 'config').mkdir(mode=0o700)
            for path in cfg.glob('*.conf'):
                require(path.is_file() and not path.is_symlink() and allowed_member('core/config/' + path.name), 'unsafe config file')
                with private_file(root / 'config' / path.name) as dst:
                    dst.write(path.read_bytes())
            for source, name in [(Path('/opt/railway-core/upstreams.env'), 'upstreams.env'),
                                 (Path('/realm-data/extraction/complete.json'), 'extraction-complete.json')]:
                if source.is_file():
                    require(not source.is_symlink(), 'unsafe source metadata')
                    with private_file(root / name) as dst:
                        dst.write(source.read_bytes())
            host = os.environ.get('DB_HOST', '')
            require(re.fullmatch(r'[A-Za-z0-9_.-]+', host) is not None, 'invalid DB host')
            port = int(os.environ.get('DB_PORT', '3306'))
            require(1 <= port <= 65535, 'invalid DB port')
            password = os.environ.get('DB_ROOT_PASSWORD')
            require(bool(password), 'DB root credential missing from runtime environment')
            env = dict(os.environ, MYSQL_PWD=password)
            base = ['--protocol=tcp', '--host=' + host, '--port=' + str(port), '--user=root']
            query = "SELECT table_schema FROM information_schema.tables WHERE table_schema IN (" + ','.join("'" + s + "'" for s in SCHEMAS) + ') GROUP BY table_schema'
            present = run(['mariadb', *base, '--batch', '--skip-column-names', '-e', query], env=env).decode().split()
            require(set(present) == set(SCHEMAS), 'one or more required schemas are absent or empty')
            with private_file(root / 'realm.sql') as dst:
                run(['mariadb-dump', *base, '--lock-all-tables', '--routines', '--events', '--triggers',
                     '--hex-blob', '--default-character-set=utf8mb4', '--databases', *SCHEMAS], env=env, stdout=dst)
        remote_check(args)
        data = {'snapshot_id': snapshot, 'role': args.role, 'project': args.project,
                'environment': args.environment, 'service': args.service, 'quiesced': True,
                'deployment': os.environ.get('RAILWAY_DEPLOYMENT_ID'),
                'commit': os.environ.get('RAILWAY_GIT_COMMIT_SHA')}
        with private_file(root / 'capture.json', 'w') as dst:
            json.dump(data, dst, sort_keys=True)
        # Capture path only; SQL/config/key material never crosses stdout or logs.
        print(str(root))
    except BaseException:
        shutil.rmtree(root)
        raise


def ssh_options(config):
    options = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes']
    if config:
        options += ['-F', str(Path(config).resolve())]
    return options


def capture(args):
    require(args.confirm_quiesced == FENCE, 'explicit saved-world/write-fence confirmation is required')
    output = outside_git(Path(args.output))
    require(output.parent.is_dir() and not output.exists(), 'output must be new with an existing parent')
    for value in (args.project, args.environment, args.web_service, args.core_service, args.db_service,
                  args.web_host, args.core_host):
        safe_identifier(value)
    snapshot = uuid.uuid4().hex
    options = ssh_options(args.ssh_config)
    with tempfile.TemporaryDirectory(prefix='realm-backup-', dir=output.parent) as directory:
        payload = Path(directory)
        restrict_private(payload)
        uploaded = []
        remote_script = '/tmp/realm-ops-' + snapshot + '.py'
        # Local batch paths use POSIX separators, including on Windows OpenSSH.
        def transfer(alias, batch):
            run(['sftp', *options, '-b', '-', alias], input=batch.encode())
        def remote_command(role, action):
            return ['python3', remote_script, action, '--role', role, '--snapshot-id', snapshot,
                    '--project', args.project, '--environment', args.environment,
                    '--service', getattr(args, role + '_service'), '--confirm-quiesced', FENCE]
        local_script = str(Path(__file__).resolve()).replace('\\', '/')
        require('"' not in local_script and '\n' not in local_script, 'unsafe local script path')
        try:
            for role in ('web', 'core'):
                alias = getattr(args, role + '_host')
                uploaded.append((role, alias))
                transfer(alias, 'put "' + local_script + '" ' + remote_script + '\n')
                run(['ssh', *options, alias, shlex.join(remote_command(role, 'remote-check'))])
            for role, alias in uploaded:
                service = getattr(args, role + '_service')
                remote_dir = '/tmp/realm-capture-' + snapshot + '-' + role
                run(['ssh', *options, alias, shlex.join(remote_command(role, 'remote-capture'))])
                local = str(payload / role).replace('\\', '/')
                require('"' not in local and '\n' not in local, 'unsafe local payload path')
                transfer(alias, 'get -R ' + remote_dir + ' "' + local + '"\n')
                receipt = json.loads((payload / role / 'capture.json').read_text())
                require(receipt['snapshot_id'] == snapshot and receipt['service'] == service and receipt['quiesced'] is True,
                        'capture receipt mismatch')
            for role, alias in uploaded:
                run(['ssh', *options, alias, shlex.join(remote_command(role, 'remote-check'))])
            metadata = {'snapshot_id': snapshot, 'quiesced': True, 'schemas': list(SCHEMAS),
                        'source': {'project': args.project, 'environment': args.environment,
                                   'web_service': args.web_service, 'core_service': args.core_service, 'db_service': args.db_service},
                        'consistency': 'All realm writers externally fenced and stopped; one globally locked four-schema SQL dump; SQLite online backup.'}
            package(payload, output, metadata)
        finally:
            for role, alias in uploaded:
                remote_dir = '/tmp/realm-capture-' + snapshot + '-' + role
                # These exact generated /tmp paths cannot be supplied by an archive/user.
                cleanup = 'import shutil,pathlib;shutil.rmtree(' + repr(remote_dir) + ',ignore_errors=True);pathlib.Path(' + repr(remote_script) + ').unlink(missing_ok=True)'
                try:
                    run(['ssh', *options, alias, shlex.join(['python3', '-c', cleanup])])
                except (BackupError, OSError):
                    print('Private remote cleanup needs operator attention: snapshot ' + snapshot, file=sys.stderr)
    print('Private backup verified and atomically completed. SHA256 ' + digest_file(output))


def restore_connection(host, port, user, password_env, environ=None):
    require(host in ('127.0.0.1', '::1') and 1024 <= port <= 65535 and port != 3306,
            'SQL drill requires explicit loopback host and nondefault port >=1024')
    safe_identifier(user)
    require(re.fullmatch(r'[A-Z][A-Z0-9_]*', password_env or '') is not None, 'invalid credential variable name')
    env = dict(os.environ if environ is None else environ)
    require(bool(env.get(password_env)), 'restore password environment variable is unset')
    env['MYSQL_PWD'] = env[password_env]
    return ['mariadb', '--protocol=tcp', '--host=' + host, '--port=' + str(port), '--user=' + user], env


def assert_empty_schemas(output):
    require(not (set(output.split()) - {'information_schema', 'mysql', 'performance_schema', 'sys'}),
            'restore destination is not an empty scratch MariaDB; import refused')


def restore_sql(args):
    safe_identifier(args.destination_label)
    require(args.confirm_isolated == 'ISOLATED_EMPTY_DATABASE:' + args.destination_label,
            'explicit named isolated-database confirmation required')
    command, env = restore_connection(args.destination_host, args.destination_port, args.destination_user, args.password_env)
    query = run([*command, '--batch', '--skip-column-names', '-e', 'SHOW DATABASES'], env=env).decode()
    assert_empty_schemas(query)
    # Stage and hash before importing; tar members do not expose a subprocess-compatible fileno.
    with tempfile.TemporaryDirectory(prefix='realm-sql-restore-') as directory:
        restrict_private(Path(directory))
        sql_path = Path(directory) / 'realm.sql'
        with private_file(sql_path) as output:
            stage_sql(args.archive, output)
        with sql_path.open('rb') as sql:
            # Requires a dedicated empty DB process, disconnected from all application services.
            result = subprocess.run(command, stdin=sql, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env)
            require(result.returncode == 0, 'scratch SQL import failed (diagnostics suppressed); discard scratch DB before retry')
    names = run([*command, '--batch', '--skip-column-names', '-e', 'SHOW DATABASES'], env=env).decode().split()
    require(set(SCHEMAS) <= set(names), 'scratch restore did not produce all four databases')
    print('SQL imported into the explicitly named scratch database. Run the application restore drill before declaring recovery verified.')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('capture', help='SSH/SFTP capture from explicitly quiesced Railway web/core services')
    for option in ('project', 'environment', 'web-service', 'core-service', 'db-service', 'web-host', 'core-host', 'output', 'confirm-quiesced'):
        p.add_argument('--' + option, required=True)
    p.add_argument('--ssh-config')
    p = commands.add_parser('verify', help='verify all members and hashes without extracting')
    p.add_argument('--archive', required=True)
    p = commands.add_parser('unpack', help='restore files only into a new local realm-restore-* scratch directory')
    p.add_argument('--archive', required=True)
    p.add_argument('--destination', required=True)
    p = commands.add_parser('restore-sql', help='import into an empty isolated loopback MariaDB on a nondefault port')
    for option in ('archive', 'destination-host', 'destination-user', 'destination-label', 'password-env', 'confirm-isolated'):
        p.add_argument('--' + option, required=True)
    p.add_argument('--destination-port', type=int, required=True)
    for action in ('remote-capture', 'remote-check'):
        p = commands.add_parser(action, help=argparse.SUPPRESS)
        p.add_argument('--role', choices=('web', 'core'), required=True)
        for option in ('snapshot-id', 'project', 'environment', 'service', 'confirm-quiesced'):
            p.add_argument('--' + option, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'capture':
            capture(args)
        elif args.command == 'remote-capture':
            remote_capture(args)
        elif args.command == 'remote-check':
            remote_check(args)
        elif args.command == 'verify':
            manifest = verify(args.archive)
            print('Verified private backup: ' + str(len(manifest['files'])) + ' files; SHA256 ' + digest_file(Path(args.archive)))
        elif args.command == 'unpack':
            unpack(args.archive, args.destination)
            print('Verified files restored into new scratch directory. No live database was changed.')
        else:
            restore_sql(args)
    except (BackupError, OSError, sqlite3.Error, ValueError) as error:
        # OSError paths and DB exception messages can contain private information.
        print('Backup operation refused or failed: ' + (str(error) if isinstance(error, BackupError) else type(error).__name__), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
