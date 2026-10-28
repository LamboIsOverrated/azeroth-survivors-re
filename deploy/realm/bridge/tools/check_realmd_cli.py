"""Compile and execute the actual pinned realmd CLI prefix with real Boost.

The startup sentinel stands exactly before the config/daemon/DB section. This
checks early-return control flow without substituting a made-up argument parser.
The complete built realmd is separately exercised by the image runtime smoke.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

START = 'int main(int argc, char* argv[])'
STOP = '#ifdef _WIN32                                                // windows service command need execute before config read'
MARKER = 'REALMD_STARTUP_SENTINEL_CONFIG_DAEMON_DB'


def prefix(source):
    if source.count(START) != 1 or source.count(STOP) != 1:
        raise ValueError('Pinned realmd CLI boundary changed')
    begin, end = source.index(START), source.index(STOP)
    if begin >= end:
        raise ValueError('Invalid pinned realmd CLI ordering')
    return source[begin:end]


def check(source_tree, legacy=False):
    actual = (Path(source_tree) / 'src/realmd/Main.cpp').read_text()
    code = '#include <iostream>\n#include <string>\n#include <boost/program_options.hpp>\n'
    code += '#define _REALMD_CONFIG "/definitely-not-a-realmd-config.conf"\n'
    code += '#define _PACKAGENAME "BRIDGE_CLI_FIXTURE"\n#define VERSION "PINNED_VERSION"\n'
    code += prefix(actual)
    code += '\nstd::cerr << "' + MARKER + '"; return 93;\n}\n'
    with tempfile.TemporaryDirectory(prefix='realmd-cli-') as directory:
        root = Path(directory)
        cpp, binary = root / 'realmd-cli.cpp', root / 'realmd-cli'
        cpp.write_text(code)
        subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++17', str(cpp), '-lboost_program_options', '-o', str(binary)], check=True)
        cases = [['--version'], ['-v'], ['--config', '/missing/never/read.conf', '--s', 'run', '--version']]
        for args in cases:
            result = subprocess.run([str(binary), *args], capture_output=True, text=True, timeout=5)
            if legacy:
                if result.returncode != 93 or MARKER not in result.stderr:
                    raise AssertionError('The pinned missing-version-handler baseline changed')
            elif result.returncode != 0 or MARKER in result.stderr or 'PINNED_VERSION' not in result.stdout:
                raise AssertionError('Version must print and exit before configuration/daemon/database startup: ' + repr(result))
        normal = subprocess.run([str(binary)], capture_output=True, text=True, timeout=5)
        if normal.returncode != 93 or MARKER not in normal.stderr:
            raise AssertionError('Normal startup must continue to configuration')
        for args in [['--help'], ['--version', '--unknown-realmd-option']]:
            invalid = subprocess.run([str(binary), *args], capture_output=True, text=True, timeout=5)
            if invalid.returncode != 1 or MARKER in invalid.stderr or 'Allowed options' not in invalid.stderr:
                raise AssertionError('Unknown argument rejection must retain the stock parser behavior')
    print('Actual pinned realmd CLI prefix: ' + ('missing handler reproduced' if legacy else 'version exits before config/daemon/DB; normal/invalid paths preserved'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source_tree')
    parser.add_argument('--expect-legacy', action='store_true')
    args = parser.parse_args()
    check(args.source_tree, args.expect_legacy)
