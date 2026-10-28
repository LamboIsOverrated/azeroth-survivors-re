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
    entry='World/Maps/Kalimdor/Kalimdor_33_49.adt',
    prefix_size=393216, restored_size=1196952,
    prefix_sha256='7b1898d8709b0084f55f339f4293397c19a70fb5267087017de8b67e0a1472f6',
    restored_sha256='9e7809c00fab5177e89b3597cb784bdb9fc1dc07abc66b2ffcaccfdc1d9b0611',
    archives={
        'patch.MPQ': dict(size=2055856542, sha256='5fe80699e8d6de05a2c76bb63a523bbf53761cc1ddf528c77a755324d8476ec1'),
        'patch-2.MPQ': dict(size=9095702, sha256='d8273a13ac9ed17be5b9a4454bd7de71d48266822c1aba44ca73defad7a4593e'),
        'terrain.MPQ': dict(size=1099777804, sha256='4ca9cb8ebc40027f15168fbc2f311d4420f5c628f1327e4317087febae1aa638'),
    })


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


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
    for name, expected in _proof['archives'].items():
        file = source / name
        if (not file.is_file() or file.stat().st_size != expected['size']
                or digest(file) != expected['sha256']):
            raise RuntimeError('Unrecognized original archive: ' + name + '; repair refused')
    marker = output / '.client-data.json'
    if output.exists():
        if not marker.is_file():
            raise RuntimeError('Incomplete derived directory exists; inspect it before retrying')
        metadata = json.loads(marker.read_text())
        manifest = metadata.get('repair', {})
        if (manifest.get('restored_sha256') != _proof['restored_sha256']
                or manifest.get('overlay_sha256') != digest(output / 'patch-2.MPQ')
                or any(not (output / file['name']).is_file()
                       or (output / file['name']).stat().st_size != file['size'] for file in metadata.get('files', []))):
            raise RuntimeError('Derived data verification failed; repair refused')
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
        manifest = dict(entry=_proof['entry'], prefix_bytes=len(prefix), declared_bytes=declared,
                        prefix_sha256=_proof['prefix_sha256'], restored_sha256=_proof['restored_sha256'],
                        restored_bytes=len(complete), original_archives=_proof['archives'],
                        overlay_sha256=digest(patch), overlay_bytes=patch.stat().st_size,
                        validation='audited exact archives; exact prefix; complete ADT bounds; overlay round-trip')
        files = [dict(name=p.name, size=p.stat().st_size) for p in sorted(staged.iterdir())]
        (staged / '.client-data.json').write_text(json.dumps(dict(files=files, repair=manifest), indent=2))
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
