"""Execute the actual generated handler carry, without a database or realm."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
BRIDGE = HERE.parent


def handler_source(patch):
    marker = 'diff --git a/src/game/Chat/Level3.cpp b/src/game/Chat/Level3.cpp\n'
    if patch.count(marker) != 1:
        raise ValueError('missing or repeated actual handler file')
    section = patch.split(marker, 1)[1].split('\ndiff --git ', 1)[0]
    added = '\n'.join(line[1:] for line in section.splitlines()
                      if line.startswith('+') and not line.startswith('+++'))
    start = 'bool ChatHandler::HandleRealmBridgeCommand(char* args)'
    if added.count(start) != 1:
        raise ValueError('missing or repeated actual handler body')
    return start + added.split(start, 1)[1] + '\n'


class GeneratedHealthHandlerTests(unittest.TestCase):
    def test_actual_generated_handler_enforces_readonly_login_gate(self):
        compiler = shutil.which('g++')
        if not compiler:
            self.skipTest('g++ unavailable; Windows MSVC equivalent is run separately')
        source = handler_source((BRIDGE / 'core/world-bridge.patch').read_text(encoding='utf-8'))
        with tempfile.TemporaryDirectory(prefix='realm-health-handler-') as scratch:
            root = Path(scratch)
            (root / 'realm-bridge-handler.inc').write_text(source, encoding='utf-8')
            binary = root / 'health-handler-test'
            compiled = subprocess.run([compiler, '-std=c++17', '-pthread', '-I', str(HERE / 'cpp'),
                                       '-I', str(BRIDGE / 'core'), '-I', str(root),
                                       str(HERE / 'cpp/health-handler.test.cpp'), '-o', str(binary)],
                                      capture_output=True, text=True, timeout=90)
            self.assertEqual(compiled.returncode, 0, compiled.stdout + compiled.stderr)
            completed = subprocess.run([str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertIn('Actual generated health handler:', completed.stdout)


if __name__ == '__main__':
    unittest.main()
