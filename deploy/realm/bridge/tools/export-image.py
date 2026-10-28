"""Export only tested binaries, their runtime libraries, templates and GPL source.

Run inside the verified image with no network. Binary tar.gz goes to stdout;
never include /config, /realm-data, environment dumps or game assets.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile


def dependencies(binary):
    result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True, timeout=15)
    if result.returncode or 'not found' in result.stdout:
        raise ValueError('Cannot export a binary with unresolved runtime dependencies')
    return {match.group(1) for match in re.finditer(r'(/[^\s]+)\s+\(', result.stdout)}


def gather(root, libraries):
    root = Path(root).resolve()
    files = {}

    def add(relative):
        path = root / relative
        if not path.is_file() or not path.resolve().is_relative_to(root):
            raise ValueError('Missing or escaped approved bundle file: ' + relative)
        files[relative] = path

    for name in ('mangosd', 'realmd'):
        add('opt/mangos/bin/' + name)
    for library in libraries:
        if not any(library.startswith(prefix) for prefix in ('/lib/', '/lib64/', '/usr/lib/')):
            raise ValueError('Unexpected runtime library location')
        add(library.lstrip('/'))
    source = root / 'opt/railway-core/source'
    if not source.is_dir():
        raise ValueError('Corresponding source package is missing')
    for path in source.rglob('*'):
        if path.is_dir():
            continue
        if not path.resolve().is_relative_to(source.resolve()) or path.name.startswith('.env') or path.suffix.lower() in ('.mpq', '.sqlite', '.key', '.pem'):
            raise ValueError('Unapproved source-package file')
        add(path.relative_to(root).as_posix())
    for name in ('runtime.py', 'adt_repair.py', 'repair_client.py', 'smoke_runtime.py',
                 'world_inventory.py', 'extraction-profile.json'):
        add('opt/railway-core/' + name)
    for path in (root / 'opt/mangos/etc').glob('*.dist'):
        add(path.relative_to(root).as_posix())
    return files


def export_bundle(root, libraries, revision, image_id, stream):
    if not re.fullmatch('[0-9a-f]{40}', revision or '') or not re.fullmatch('sha256:[0-9a-f]{64}', image_id or ''):
        raise ValueError('Actual tested source commit and image ID are required')
    files = gather(root, libraries)
    manifest = {'formatVersion': 1, 'sourceCommit': revision, 'imageId': image_id,
                'phase': 'TEST-disabled', 'containsGameAssets': False, 'files': {}}
    for name, path in sorted(files.items()):
        with path.open('rb') as source:
            checksum = hashlib.file_digest(source, 'sha256').hexdigest()
        manifest['files']['root/' + name] = {'sha256': checksum, 'size': path.stat().st_size}
    encoded = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    with gzip.GzipFile(fileobj=stream, mode='wb', mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w|') as archive:
            member = tarfile.TarInfo('manifest.json')
            member.size, member.mode, member.mtime = len(encoded), 0o644, 0
            archive.addfile(member, io.BytesIO(encoded))
            for name, path in sorted(files.items()):
                member = tarfile.TarInfo('root/' + name)
                member.size, member.mode, member.mtime = path.stat().st_size, path.stat().st_mode & 0o777, 0
                with path.open('rb') as source:
                    archive.addfile(member, source)
    return manifest


if __name__ == '__main__':
    libraries = set()
    for name in ('mangosd', 'realmd'):
        libraries.update(dependencies(Path('/opt/mangos/bin') / name))
    export_bundle('/', libraries, os.environ.get('BUNDLE_SOURCE_COMMIT'),
                  os.environ.get('BUNDLE_IMAGE_ID'), sys.stdout.buffer)
