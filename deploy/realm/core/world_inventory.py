"""Attest all generated world files against the audited extraction profile.

This contains metadata only. A legacy completion marker cannot attest a tree;
sealing requires its full content to equal the independently accepted tree root.
"""
import hashlib
import json
from pathlib import Path

FOLDERS = ('dbc', 'maps', 'vmaps', 'mmaps')
PROFILE_PATH = Path(__file__).with_name('extraction-profile.json')


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def canonical(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=True, sort_keys=True).encode('ascii')


def summary(rows):
    return {'count': len(rows), 'bytes': sum(row[1] for row in rows),
            'sha256': hashlib.sha256(canonical(rows)).hexdigest()}


def profile_id(profile):
    return hashlib.sha256(canonical(profile)).hexdigest()


def load_profile():
    profile = json.loads(PROFILE_PATH.read_text(encoding='utf-8'))
    if profile.get('version') != 1 or not profile.get('core') or not profile.get('tools') or not profile.get('inputs'):
        raise RuntimeError('audited extraction profile missing or invalid')
    return profile


def scan_outputs(data):
    rows = []
    for name in FOLDERS:
        directory = data / name
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError('world inventory folder missing or symlinked: ' + name)
        files = 0
        for path in sorted(directory.rglob('*')):
            if path.is_symlink():
                raise RuntimeError('world inventory symlink refused: ' + str(path))
            if path.is_dir():
                continue
            if not path.is_file():
                raise RuntimeError('world inventory non-regular file refused: ' + str(path))
            rows.append([path.relative_to(data).as_posix(), path.stat().st_size, digest(path)])
            files += 1
        if not files:
            raise RuntimeError('world inventory folder is empty: ' + name)
    return sorted(rows)


def verify_sources(client, tools, config, profile):
    directory = client / 'Data'
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError('extraction input directory missing or symlinked')
    rows = []
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            # The first audited derivation linked unchanged archives to their
            # read-only originals, and patch-2 to its audited private overlay.
            # Accept only those exact destinations; every linked byte is still
            # checked against the pinned inventory.
            originals = client.parent / 'client-original' / 'Data'
            candidates = [originals / path.name]
            if path.name == 'patch-2.MPQ':
                candidates.append(client.parent / 'client-overlay' / 'patch-2.MPQ')
            if (path.parent != directory or originals.parent.is_symlink() or originals.is_symlink()
                    or not any(not target.parent.is_symlink() and not target.is_symlink()
                               and target.is_file() and path.resolve(strict=True) == target.resolve(strict=True)
                               for target in candidates)):
                raise RuntimeError('extraction input symlink refused')
        if path.suffix.lower() == '.mpq':
            if not path.is_file():
                raise RuntimeError('extraction input archive is not a regular file')
            rows.append([path.relative_to(client).as_posix(), path.stat().st_size, digest(path)])
    if sorted(rows) != sorted(profile['inputs']):
        raise RuntimeError('extraction input inventory differs from the audited profile')
    for name, expected in profile['tools'].items():
        path = config if name == '@config' else tools / name
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise RuntimeError('extraction extractor/profile content mismatch: ' + name)


def accepted_outputs(data, profile):
    rows = scan_outputs(data)
    if summary(rows) != profile['outputs']:
        raise RuntimeError('world inventory differs from the audited complete extraction; repair required')
    return rows


def seal_outputs(data, marker, profile):
    rows = accepted_outputs(data, profile)
    record = {'version': 2, 'core': profile['core'], 'profile': profile_id(profile), 'files': rows}
    marker.parent.mkdir(parents=True, exist_ok=True)
    temporary = marker.with_name(marker.name + '.tmp')
    temporary.write_bytes(canonical(record))
    temporary.chmod(0o600)
    temporary.replace(marker)


def verify_outputs(data, marker, profile):
    record = json.loads(marker.read_text(encoding='utf-8'))
    if (record.get('version') != 2 or record.get('core') != profile['core']
            or record.get('profile') != profile_id(profile)):
        raise RuntimeError('world inventory manifest has no valid extraction attestation')
    rows = accepted_outputs(data, profile)
    if record.get('files') != rows:
        raise RuntimeError('world inventory manifest does not describe the complete accepted tree')


def verify(root, tools=Path('/opt/mangos/bin/tools'),
           config=Path('/opt/src/mangos-classic/contrib/extractor_scripts/config.json'), expected_core=None):
    profile = load_profile()
    if expected_core is not None and profile['core'] != expected_core:
        raise RuntimeError('extraction profile does not match the pinned core')
    # Reject legacy/tampered markers before hashing multi-gigabyte source data.
    marker = root / 'extraction/complete.json'
    record = json.loads(marker.read_text(encoding='utf-8'))
    if record.get('version') != 2 or record.get('profile') != profile_id(profile):
        raise RuntimeError('world inventory manifest requires complete attestation')
    verify_sources(root / 'client', tools, config, profile)
    verify_outputs(root / 'data', marker, profile)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    verify(args.root)
    print('Complete extraction and source profile verified')
