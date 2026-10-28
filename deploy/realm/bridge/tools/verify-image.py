"""Run inside the built TEST bridge image with networking disabled. No SQL/assets."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

REVISION = 'de8f72993b9e1faa1bf92dd5505f3daec5cea3ce'


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{64}', value):
        raise ValueError('Expected source checksum is required')
    return value


def verify_source(root, header_sha, patch_sha):
    root = Path(root)
    header_sha, patch_sha = digest(header_sha), digest(patch_sha)
    source = root / 'opt/railway-core/source'
    patch = source / 'bridge/core/world-bridge.patch'
    if hashlib.sha256(patch.read_bytes()).hexdigest() != patch_sha:
        raise ValueError('Packaged patch does not match the tested revision')
    manifest = json.loads((source / 'bridge/core/pinned-sources.json').read_text())
    if manifest.get('revision') != REVISION or not manifest.get('files'):
        raise ValueError('Packaged source revision is not the pinned core')
    with tarfile.open(source / 'cmangos-bridge-source.tar.gz', 'r:gz') as archive:
        for name in ('src/shared/Database/WorldBridge.h', 'LICENSE', 'AUTHORS.md'):
            member = archive.getmember('mangos-classic/' + name)
            if not member.isfile() or not 0 < member.size < 1024 * 1024:
                raise ValueError('Missing regular source/license member')
            data = archive.extractfile(member).read()
            if name.endswith('WorldBridge.h') and hashlib.sha256(data).hexdigest() != header_sha:
                raise ValueError('Packaged world-owner kernel does not match the tested source')


def verify_runtime(root='/'):
    for name in ('CORE_PLAYERBOTS_COMPILED', 'CORE_AHBOT_COMPILED', 'REALM_BRIDGE_TEST_ENABLE'):
        if os.environ.get(name) != '0':
            raise ValueError('Image must declare bots and TEST bridge disabled: ' + name)
    for name in ('mangosd', 'realmd'):
        binary = str(Path(root) / 'opt/mangos/bin' / name)
        linked = subprocess.run(['ldd', binary], capture_output=True, text=True, timeout=15)
        if linked.returncode or 'not found' in linked.stdout:
            raise ValueError('Runtime ABI/linker verification failed for ' + name)
        # These pinned binaries have different CLI contracts: realmd has no
        # --help option, while mangosd's help is needed to inspect bot flags.
        probe = '--help' if name == 'mangosd' else '--version'
        help_result = subprocess.run([binary, probe], capture_output=True, text=True, timeout=15)
        if help_result.returncode:
            raise ValueError('Actual binary argument parsing failed for ' + name)
        # Main.cpp at this pin always declares the AH configuration option.
        # Only the playerbot/aiplayerbot CLI is conditional on compiled support;
        # AH scheduling is checked by the pinned build flag and runtime policy.
        if name == 'mangosd' and 'playerbot' in help_result.stdout.lower():
            raise ValueError('Image world binary unexpectedly includes a background bot CLI')


if __name__ == '__main__':
    verify_source('/', os.environ.get('EXPECTED_BRIDGE_HEADER_SHA256'),
                  os.environ.get('EXPECTED_BRIDGE_PATCH_SHA256'))
    verify_runtime()
    print('Actual TEST image ABI, disabled capabilities, pinned source carry and license package verified.')
