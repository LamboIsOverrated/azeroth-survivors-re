"""Image smoke checks: real CLI parsing and status-only maintenance, no SQL/assets."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

import runtime


class RuntimeImageSmoke(unittest.TestCase):
    def test_compiled_bridge_declares_mandatory_test_off_schema_gate(self):
        capabilities = runtime.compiled_capabilities(os.environ)
        self.assertEqual(capabilities['CORE_REALM_BRIDGE_COMPILED'], '1')
        self.assertEqual(capabilities['REALM_BRIDGE_TEST_ENABLE'], '0')
        with tempfile.TemporaryDirectory() as temporary, \
                patch.object(runtime, 'bridge_schema_metadata', side_effect=RuntimeError('smoke missing schema')) as probe:
            with self.assertRaisesRegex(RuntimeError, '001-world-bridge.sql.*002-missing-character-reason.sql'):
                runtime.require_bridge_schema(capabilities, Path(temporary))
            probe.assert_called_once()
        for name in ('001-world-bridge.sql', '002-missing-character-reason.sql'):
            self.assertTrue((Path('/opt/railway-core/source/bridge/core')/name).is_file())

    def test_actual_binary_arguments_and_declared_templates(self):
        capabilities = runtime.compiled_capabilities(os.environ)
        cfg = runtime.settings(dict(capabilities, DB_ROOT_PASSWORD='SmokeRoot12345',
                                    DB_MANGOS_PASSWORD='SmokeCore12345', DB_REALMWEB_PASSWORD='SmokeWeb12345',
                                    SOAP_ADMIN_USERNAME='SMOKEOPS', SOAP_ADMIN_PASSWORD='SmokeOnly1234'))
        templates = Path(os.environ.get('CORE_SMOKE_TEMPLATES', '/opt/mangos/etc'))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime.configure(cfg, root, templates)
            commands = runtime.game_commands(cfg, root)
            binaries = [os.environ.get('CORE_SMOKE_REALMD', commands[0][0]),
                        os.environ.get('CORE_SMOKE_MANGOSD', commands[1][0])]
            for binary, command in zip(binaries, commands):
                # Auth's pinned parser has no --help option; --version still
                # parses the generated arguments and exits without opening SQL.
                inspection = '--version' if command[0].endswith('/realmd') else '--help'
                result = subprocess.run([binary, *command[1:], inspection], capture_output=True, text=True,
                                        timeout=15, env=runtime.game_options(cfg)['env'])
                self.assertEqual(result.returncode, 0, result.stderr)
                if command[0].endswith('/mangosd'):
                    compiled = 'playerbot' in result.stdout.lower()
                    self.assertEqual(compiled, capabilities['CORE_PLAYERBOTS_COMPILED'] == '1')
            for flag, name, option in [('CORE_PLAYERBOTS_COMPILED', 'aiplayerbot', '-p'),
                                       ('CORE_AHBOT_COMPILED', 'ahbot', '-a')]:
                enabled = capabilities[flag] == '1'
                self.assertEqual((root/'config'/(name+'.conf')).exists(), enabled)
                self.assertEqual(option in commands[1], enabled)

    def test_maintenance_has_no_children_or_ready_world(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        env = {key: os.environ[key] for key in ('PATH', 'LANG', 'HOME') if key in os.environ}
        env.update(REALM_MAINTENANCE='1', PORT=str(port))
        process = subprocess.Popen([sys.executable, str(Path(runtime.__file__)), 'serve'], env=env)
        try:
            deadline = time.monotonic() + 10
            while True:
                self.assertIsNone(process.poll(), 'Maintenance wrapper exited')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=.5) as response:
                        health = json.load(response)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        self.fail('Maintenance HTTP did not start')
                    time.sleep(.05)
            self.assertIs(health['maintenance'], True)
            self.assertIs(health['ready'], False)
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/readyz', timeout=.5)
            self.assertEqual(rejected.exception.code, 503)
            rejected.exception.close()
            children = Path(f'/proc/{process.pid}/task/{process.pid}/children')
            self.assertEqual(children.read_text().strip(), '')
        finally:
            process.terminate()
            process.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
