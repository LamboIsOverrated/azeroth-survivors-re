"""Apply the reviewed browser movement carry after the separate bridge carry.

No network, database or deployment operations. Source hashes are authoritative;
the companion bridge modifies different files, so its carry may already be applied.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

REVISION = 'de8f72993b9e1faa1bf92dd5505f3daec5cea3ce'
PATHS = frozenset(('src/game/Anticheat/module/libanticheat.cpp',
                   'src/game/Anticheat/module/Movement/movement.cpp',
                   'src/game/Anticheat/module/Movement/movement.hpp'))
HEADER = 'src/game/Anticheat/module/Movement/BrowserMovementBudget.h'


def canonical(path):
    return path.read_text(encoding='utf-8').replace('\r\n', '\n').encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_manifest(here):
    manifest = json.loads((here/'anticheat-sources.json').read_text(encoding='utf-8'))
    if manifest.get('revision') != REVISION or set(manifest.get('files', {})) != PATHS:
        raise ValueError('Unexpected pinned revision or source paths')
    for name, key in (('browser-anticheat.patch', 'patch_sha256'),
                      ('BrowserMovementBudget.h', 'header_sha256')):
        if digest(canonical(here/name)) != manifest.get(key):
            raise ValueError('Reviewed patch/header hash mismatch: ' + name)
    return manifest


def verify_files(root, manifest, state):
    if set(manifest.get('files', {})) != PATHS:
        raise ValueError('Unexpected source paths')
    for name, hashes in manifest['files'].items():
        path = root/name
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('Pinned source missing or unsafe: ' + name)
        if digest(canonical(path)) != hashes[state]:
            raise ValueError('Pinned source mismatch: ' + name)


def git(root, *arguments):
    result = subprocess.run(['git', '-C', str(root), *arguments],
                            capture_output=True, text=True, check=False)
    if result.returncode:
        raise ValueError('Source Git operation failed: ' + result.stderr.strip())
    return result.stdout.strip()


def apply(root, here, mutate=False):
    root, here = root.resolve(), here.resolve()
    manifest = load_manifest(here)
    if git(root, 'rev-parse', 'HEAD') != REVISION:
        raise ValueError('Only the exact pinned core revision is supported')
    verify_files(root, manifest, 'before')
    if (root/HEADER).exists() or (root/HEADER).is_symlink():
        raise ValueError('Movement header already exists; use a fresh pinned checkout')
    patch = here/'browser-anticheat.patch'
    git(root, 'apply', '--check', str(patch))
    if mutate:
        git(root, 'apply', str(patch))
        (root/HEADER).write_bytes(canonical(here/'BrowserMovementBudget.h'))
        verify_files(root, manifest, 'after')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    apply(args.source, Path(__file__).parent, args.apply)
    print('Pinned browser movement carry ' + ('applied' if args.apply else 'verified') +
          '; real core compilation and isolated gameplay acceptance remain required.')


if __name__ == '__main__':
    main()
