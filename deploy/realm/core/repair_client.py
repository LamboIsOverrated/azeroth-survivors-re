"""Derive a private repaired client tree from the exact audited input.

Original MPQs remain byte-identical and are made read-only. Only a copy of the
highest patch is amended. No client assets or extracted assets are bundled.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from adt_repair import verified_prefix

KNOWN = dict(
    source_version='vanilla-5875-enUS-audited-candidate-20261028-v1',
    entry='World/Maps/Kalimdor/Kalimdor_33_49.adt',
    prefix_size=393216, restored_size=1196952,
    prefix_sha256='7b1898d8709b0084f55f339f4293397c19a70fb5267087017de8b67e0a1472f6',
    restored_sha256='9e7809c00fab5177e89b3597cb784bdb9fc1dc07abc66b2ffcaccfdc1d9b0611',
    archives={
        'backup.MPQ': dict(size=6341628, sha256='5f95175d6046827bbd46ec207a78032a9279fbcf4163c308fb73655f537ff26a'),
        'base.MPQ': dict(size=11202638, sha256='8664981b6ae6f43ad2c2a3670e7b92fb6765da200b427a7e57e03c5cb5645241'),
        'dbc.MPQ': dict(size=3875834, sha256='a37649169842347ae37a270f49b005a95e184f5ba3d2c1d2d16f37ea2bb902e4'),
        'fonts.MPQ': dict(size=1284223, sha256='0e8a8121f40ff27dad6beba63a83b708c753762c898420a674a74987a6e31522'),
        'interface.MPQ': dict(size=69655328, sha256='9ac598e8c1595f0c50276860936956e6196ef5f041de13db79a5d75b6be99105'),
        'misc.MPQ': dict(size=6084832, sha256='59c4138eefb00f6e640667cd7d16decaec4b2048ee17dc4f58195bd93d7c6a60'),
        'model.MPQ': dict(size=190911084, sha256='d8f168e2d346a113076e5b100296cc8f77cc74db2f85e16d25052bc5fc59b639'),
        'patch.MPQ': dict(size=2055856542, sha256='5fe80699e8d6de05a2c76bb63a523bbf53761cc1ddf528c77a755324d8476ec1'),
        'patch-2.MPQ': dict(size=9095702, sha256='d8273a13ac9ed17be5b9a4454bd7de71d48266822c1aba44ca73defad7a4593e'),
        'sound.MPQ': dict(size=707653955, sha256='7ccbaef51dd998366d5d71b5d702caef9518e415066fb94d7c503fe07deda4cb'),
        'speech.MPQ': dict(size=229168847, sha256='1759231dfb0427d4ad48d6cde23623df8eb3e35f8bf8b40ed2abbb89005be6dd'),
        'terrain.MPQ': dict(size=1099777804, sha256='4ca9cb8ebc40027f15168fbc2f311d4420f5c628f1327e4317087febae1aa638'),
        'texture.MPQ': dict(size=664940439, sha256='5768dc52b2e59f6854e3c30812644af86d1834d60b2d5970860cea893c0c4c07'),
        'wmo.MPQ': dict(size=363565077, sha256='00d40ff633cd71ab60f20833a06b18e9638132227c8c1d2bc509c905e51552ce'),
    },
    derived_overlay=dict(size=9597150, sha256='9f9e27a09374d1f669dfe280c1d8c0c9dd148c8d89237c6b58a701bc9e1b3c5e'))

MANIFEST_VERSION = 2


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def verify_files(directory, expected, label):
    files = [p for p in directory.rglob('*') if p.suffix.lower() == '.mpq']
    if (len(files) != len(expected) or any(p.parent != directory or not p.is_file() for p in files)
            or {p.name for p in files} != set(expected)):
        raise RuntimeError(label + ' archive inventory mismatch; verification refused')
    for name, specification in expected.items():
        file = directory / name
        if file.stat().st_size != specification['size'] or digest(file) != specification['sha256']:
            raise RuntimeError(label + ' archive content mismatch: ' + name + '; verification refused')


def repair_manifest(proof):
    return dict(source_version=proof['source_version'], derivation_version=1,
                entry=proof['entry'], prefix_bytes=proof['prefix_size'], declared_bytes=proof['restored_size'],
                prefix_sha256=proof['prefix_sha256'], restored_sha256=proof['restored_sha256'],
                restored_bytes=proof['restored_size'], original_archives=proof['archives'],
                overlay_sha256=proof['derived_overlay']['sha256'], overlay_bytes=proof['derived_overlay']['size'],
                validation='all original/derived MPQ SHA256s; exact prefix; complete ADT bounds; overlay round-trip')


def write_manifest(directory, metadata):
    marker = directory / '.client-data.json'
    temporary = directory / '.client-data.json.partial'
    with temporary.open('w', encoding='utf-8') as output:
        json.dump(metadata, output, indent=2, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(marker)


def validate_manifest(metadata, expected, manifest, proof):
    legacy = metadata.get('manifest_version') is None and metadata.get('source_version') is None
    if not legacy and (type(metadata.get('manifest_version')) is not int
                       or metadata['manifest_version'] != MANIFEST_VERSION
                       or metadata.get('source_version') != proof['source_version']):
        raise RuntimeError('Derived manifest version mismatch; verification refused')
    rows = metadata.get('files')
    if not isinstance(rows, list) or len(rows) != len(expected):
        raise RuntimeError('Derived manifest inventory mismatch; verification refused')
    names = []
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('name'), str) or row['name'] not in expected:
            raise RuntimeError('Derived manifest filename mismatch; verification refused')
        names.append(row['name'])
        spec = expected[row['name']]
        if (type(row.get('size')) is not int or row['size'] != spec['size']
                or (not legacy and row.get('sha256') != spec['sha256'])):
            raise RuntimeError('Derived manifest content proof mismatch; verification refused')
    if len(set(names)) != len(expected):
        raise RuntimeError('Derived manifest duplicate filename; verification refused')
    recorded = metadata.get('repair')
    if not isinstance(recorded, dict):
        raise RuntimeError('Derived repair proof missing; verification refused')
    if legacy:
        # Only the known previous helper format can be upgraded. All file bytes
        # are independently checked against the source-pinned profile first.
        keys = ('entry', 'prefix_bytes', 'declared_bytes', 'prefix_sha256',
                'restored_sha256', 'restored_bytes', 'overlay_sha256', 'overlay_bytes')
        if any(recorded.get(key) != manifest[key] for key in keys):
            raise RuntimeError('Derived legacy repair proof mismatch; verification refused')
    elif recorded != manifest:
        raise RuntimeError('Derived repair proof mismatch; verification refused')
    return legacy


class MpqTool:
    def read(self, archive, entry, workspace):
        directory = workspace / archive.name
        directory.mkdir(parents=True, exist_ok=True)
        listing = subprocess.run(['smpq', '-l', str(archive), entry], capture_output=True, text=True, check=True)
        lines = listing.stdout.splitlines()
        if len(lines) != 1:
            raise RuntimeError('Expected MPQ entry is missing or ambiguous')
        declared = int(lines[0].split()[0])
        result = subprocess.run(['smpq', '-x', '-f', str(archive), entry],
                                cwd=directory, capture_output=True, text=True)
        target = directory / entry
        data = target.read_bytes() if target.is_file() else b''
        # StormLib's command-line utility can exit zero on a failed partial read.
        complete = result.returncode == 0 and not result.stderr.strip() and len(data) == declared
        return data, declared, complete

    def append(self, archive, entry, data, workspace):
        directory = workspace / 'append'
        target = directory / entry
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        os.utime(target, (0, 0))
        subprocess.run(['smpq', '-a', '-f', '-C', 'ZLIB', str(archive), entry],
                       cwd=directory, capture_output=True, check=True)


def repair(source, output, *, _proof=KNOWN, tool=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError('Original and derived data directories must be separate siblings')
    tool = tool or MpqTool()
    verify_files(source, _proof['archives'], 'Original')
    expected = {name: dict(specification) for name, specification in _proof['archives'].items()}
    expected['patch-2.MPQ'] = dict(_proof['derived_overlay'])
    manifest = repair_manifest(_proof)
    metadata = dict(manifest_version=MANIFEST_VERSION, source_version=_proof['source_version'],
                    files=[dict(name=name, **expected[name]) for name in sorted(expected)], repair=manifest)
    marker = output / '.client-data.json'
    if output.exists():
        if not marker.is_file():
            raise RuntimeError('Incomplete derived directory exists; inspect it before retrying')
        try:
            recorded = json.loads(marker.read_text())
            if not isinstance(recorded, dict):
                raise ValueError('not an object')
        except (OSError, ValueError):
            raise RuntimeError('Derived manifest unreadable; verification refused') from None
        legacy = validate_manifest(recorded, expected, manifest, _proof)
        verify_files(output, expected, 'Derived')
        if legacy:
            write_manifest(output, metadata)
        return manifest
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='repair-', dir=output.parent) as temporary:
        workspace = Path(temporary)
        prefix, declared, partial_ok = tool.read(source / 'patch.MPQ', _proof['entry'], workspace)
        complete, base_declared, base_ok = tool.read(source / 'terrain.MPQ', _proof['entry'], workspace)
        if (partial_ok or not base_ok or len(prefix) != _proof['prefix_size']
                or declared != _proof['restored_size'] or base_declared != declared
                or hashlib.sha256(prefix).hexdigest() != _proof['prefix_sha256']
                or hashlib.sha256(complete).hexdigest() != _proof['restored_sha256']
                or not verified_prefix(prefix, complete, declared)):
            raise RuntimeError('Known prefix/base repair proof failed; no input was changed')
        staged = workspace / 'derived'
        staged.mkdir()
        originals = sorted(p for p in source.iterdir() if p.is_file() and p.suffix.lower() == '.mpq')
        for file in originals:
            target = staged / file.name
            if file.name == 'patch-2.MPQ':
                shutil.copyfile(file, target)
                target.chmod(0o600)
            else:
                try:
                    os.link(file, target)
                except OSError:
                    # Separate filesystems cannot hardlink. Copy without changing originals.
                    shutil.copyfile(file, target)
        patch = staged / 'patch-2.MPQ'
        tool.append(patch, _proof['entry'], complete, workspace)
        roundtrip, roundtrip_size, ok = tool.read(patch, _proof['entry'], workspace / 'roundtrip')
        if not ok or roundtrip_size != declared or roundtrip != complete:
            raise RuntimeError('Derived overlay round-trip verification failed')
        verify_files(staged, expected, 'Derived')
        with patch.open('r+b') as overlay:
            os.fsync(overlay.fileno())
        write_manifest(staged, metadata)
        if os.name != 'nt':
            for file in originals:
                file.chmod(0o444)
            for file in staged.glob('*.MPQ'):
                file.chmod(0o444)
        staged.replace(output)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    manifest = repair(args.source, args.output)
    print('Private derived client verified; restored entry SHA256 ' + manifest['restored_sha256'], flush=True)


if __name__ == '__main__':
    main()
