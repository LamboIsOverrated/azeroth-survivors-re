import importlib.util
from contextlib import ExitStack
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
import types
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('runtime', HERE / 'runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def test_game_child_failure_exits_for_restart_but_bootstrap_failure_holds_for_repair(self):
        for failed_after_launch in (False, True):
            with self.subTest(failed_after_launch=failed_after_launch), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                cfg = runtime.settings(self.env())
                child = types.SimpleNamespace(poll=lambda: 17)
                stop = unittest.mock.Mock()
                stop.wait.return_value = False
                stop.is_set.return_value = False
                server = unittest.mock.Mock()
                fake_fcntl = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *args: None)
                contexts = [patch.dict(sys.modules, {'fcntl': fake_fcntl}),
                            patch.object(runtime, 'Path', return_value=root),
                            patch.object(runtime, 'settings', return_value=cfg),
                            patch.object(runtime, 'configure'),
                            patch.object(runtime, 'bootstrap', side_effect=None if failed_after_launch else RuntimeError('bootstrap failed')),
                            patch.object(runtime, 'extraction_ready', return_value=True),
                            patch.object(runtime, 'prepare_game_permissions'),
                            patch.object(runtime.subprocess, 'Popen', return_value=child),
                            patch.object(runtime, 'STOP', stop),
                            patch.object(runtime, 'CHILDREN', []),
                            patch.object(runtime, 'ThreadingHTTPServer', return_value=server),
                            patch.object(runtime.threading, 'Thread'),
                            patch.object(runtime.signal, 'signal'),
                            patch.object(runtime.sys, 'argv', ['runtime.py', 'serve']),
                            patch.dict(runtime.os.environ, {'REALM_MAINTENANCE': '0'}, clear=True)]
                with ExitStack() as stack:
                    for context in contexts:
                        stack.enter_context(context)
                    stop_children = stack.enter_context(patch.object(runtime, 'stop_children'))
                    if failed_after_launch:
                        with self.assertRaisesRegex(RuntimeError, 'core child exited'):
                            runtime.main()
                        self.assertEqual(stop.wait.call_count, 1, 'must not enter the indefinite repair hold')
                    else:
                        runtime.main()
                        stop.wait.assert_called_once_with()
                    self.assertGreaterEqual(stop_children.call_count, 1)
                    server.shutdown.assert_called()

    def test_maintenance_runs_only_status_without_database_credentials_in_all_modes(self):
        for mode in ('serve', 'initialize', 'extract'):
            with self.subTest(mode=mode), socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
                reservation.close()
                env = {key: value for key, value in os.environ.items()
                       if not key.startswith(('DB_', 'SOAP_', 'REALM_'))}
                env.update(REALM_MAINTENANCE='1', PORT=str(port))
                process = subprocess.Popen([sys.executable, '-B', str(HERE / 'runtime.py'), mode],
                                           env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 5
                    while True:
                        if process.poll() is not None:
                            self.fail('Maintenance wrapper exited instead of serving status: '
                                      + process.stderr.read().decode(errors='replace'))
                        try:
                            with urllib.request.urlopen(f'http://127.0.0.1:{port}/healthz', timeout=.3) as reply:
                                health = json.load(reply)
                                self.assertEqual(reply.status, 200)
                                self.assertEqual(reply.headers['Cache-Control'], 'no-store')
                            break
                        except (OSError, urllib.error.URLError):
                            if time.monotonic() >= deadline:
                                self.fail('Maintenance status did not start')
                            time.sleep(.02)
                    self.assertIs(health['maintenance'], True)
                    self.assertIs(health['ready'], False)
                    self.assertEqual(health['phase'], 'maintenance')
                    for key in ('database', 'data', 'login', 'world', 'soap'):
                        self.assertIs(health[key], False)
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        urllib.request.urlopen(f'http://127.0.0.1:{port}/readyz', timeout=.5)
                    self.assertEqual(failure.exception.code, 503)
                    self.assertIs(json.load(failure.exception)['maintenance'], True)
                    children = pathlib.Path(f'/proc/{process.pid}/task/{process.pid}/children')
                    if children.is_file():
                        self.assertEqual(children.read_text().strip(), '')
                finally:
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=5)

    def test_invalid_maintenance_value_fails_before_initialization(self):
        with patch.dict(runtime.os.environ, {'REALM_MAINTENANCE': 'true'}, clear=True), \
                patch.object(runtime, 'settings', side_effect=AssertionError('DB settings must not be read')), \
                patch.object(runtime.subprocess, 'Popen', side_effect=AssertionError('writers must not start')):
            with self.assertRaisesRegex(ValueError, 'REALM_MAINTENANCE'):
                runtime.main()

    def test_core_build_context_is_standalone(self):
        dockerfile = (HERE / 'Dockerfile').read_text()
        self.assertNotIn('COPY deploy/', dockerfile)
        self.assertIn('COPY runtime.py ', dockerfile)
        self.assertFalse((HERE / 'railway.json').exists())

    def env(self, **extra):
        return dict(DB_HOST='db.railway.internal', DB_ROOT_PASSWORD='Root_safe_123',
                    DB_MANGOS_PASSWORD='Core_safe_123', DB_REALMWEB_PASSWORD='Web_safe_123',
                    REALM_DOMAIN='realm-core.railway.internal', SOAP_ADMIN_USERNAME='REALMOPS',
                    SOAP_ADMIN_PASSWORD='OpsSafe123456', **extra)

    def test_config_rejects_injected_password_host_and_domain(self):
        for key, value in [('DB_MANGOS_PASSWORD', 'abc;def'), ('DB_HOST', 'x\nGameType=0'),
                           ('DB_ROOT_PASSWORD', "x' OR 1=1"), ('REALM_DOMAIN', 'https://x'),
                           ('REALM_DOMAIN', 'realm-web-pvp-staging.up.railway.app'),
                           ('SOAP_ADMIN_USERNAME', 'ADMINISTRATOR')]:
            env = self.env()
            env[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                runtime.settings(env)

    def test_config_forces_pvp_private_ports_and_bots_off_on_every_boot(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            templates = root / 'templates'
            templates.mkdir()
            for name in ['mangosd', 'realmd', 'ahbot', 'aiplayerbot', 'anticheat']:
                (templates / (name + '.conf.dist')).write_text('[Config]\nGameType=0\n')
            runtime.configure(runtime.settings(self.env()), root, templates)
            world = (root / 'config/mangosd.conf').read_text()
            self.assertIn('GameType = 1', world)
            self.assertIn('WorldServerPort = 8085', world)
            self.assertIn('SOAP.Port = 7878', world)
            self.assertIn('Ra.Enable = 0', world)
            self.assertIn('Console.Enable = 0', world)
            self.assertIn('AuctionHouseBot.Chance.Sell = 0', (root / 'config/ahbot.conf').read_text())
            self.assertIn('AuctionHouseBot.Chance.Buy = 0', (root / 'config/ahbot.conf').read_text())
            self.assertIn('AiPlayerbot.Enabled = 0', (root / 'config/aiplayerbot.conf').read_text())

    def test_missing_or_empty_required_data_never_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            for name in ['dbc', 'maps', 'vmaps', 'mmaps']:
                (root / name).mkdir()
            self.assertFalse(runtime.data_ready(root))
            for name, filename in [('dbc', 'Map.dbc'), ('maps', '000.map'),
                                    ('vmaps', '000.vmtree'), ('mmaps', '000.mmap')]:
                (root / name / filename).write_bytes(b'data')
            self.assertTrue(runtime.data_ready(root))
            (root / 'mmaps/000.mmap').unlink()
            self.assertFalse(runtime.data_ready(root))

    def test_bootstrap_existing_data_never_imports(self):
        existing = {'classicrealmd': 10, 'classiccharacters': 50, 'classicmangos': 100,
                    'classiclogs': 8}
        self.assertEqual(runtime.bootstrap_action(existing, ready=True), 'preserve')
        self.assertEqual(runtime.bootstrap_action(dict.fromkeys(existing, 0), ready=False), 'install')
        with self.assertRaisesRegex(RuntimeError, 'preserv'):
            runtime.bootstrap_action(existing, ready=False)

    def test_srp_matches_upstream_seeded_administrator_verifier(self):
        salt = '8EB5DE915AA3D805FA7099CF61C0BB8A77990EA869078A0C5B9EEE55828F4505'
        self.assertEqual(runtime.srp('ADMINISTRATOR', 'ADMINISTRATOR', salt)[1],
                         '312B99EEF1C0196BB73B79D114CE161C5D089319E6EF54FAA6117DAB8B672C14')

    def test_schema_sql_does_not_elevate_normal_accounts(self):
        sql = runtime.security_sql(runtime.settings(self.env()))
        self.assertIn('gmlevel=3', sql)
        self.assertIn("WHERE username='REALMOPS'", sql)
        self.assertIn('icon=1', sql)
        self.assertIn("realmbuilds='5875'", sql)
        self.assertNotIn('GRANT ALL ON *.*', sql)
        self.assertNotIn('sha_pass_hash', sql)

    def test_supervisor_terminates_and_waits_for_children(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], start_new_session=True)
        runtime.stop_children([process], grace=2)
        self.assertIsNotNone(process.poll())

    def test_partial_extraction_outputs_cannot_start_world_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            for name, filename in [('dbc', 'Map.dbc'), ('maps', '000.map'),
                                    ('vmaps', '000.vmtree'), ('mmaps', '000.mmap')]:
                (root / 'data' / name).mkdir(parents=True)
                (root / 'data' / name / filename).write_bytes(b'partial')
            self.assertFalse(runtime.extraction_ready(root))
            (root / 'extraction').mkdir()
            (root / 'extraction/complete.json').write_text('{"core":"wrong"}')
            self.assertFalse(runtime.extraction_ready(root))
            (root / 'extraction/complete.json').write_text('{"core":"' + runtime.CORE + '"}')
            self.assertTrue(runtime.extraction_ready(root))

    def test_game_child_has_no_operator_secrets_and_drops_privileges(self):
        options = runtime.game_options(self.env(PATH='/usr/bin', LANG='C.UTF-8'))
        self.assertEqual(options['user'], 10001)
        self.assertEqual(options['group'], 10001)
        self.assertEqual(options['extra_groups'], [])
        self.assertNotIn('DB_ROOT_PASSWORD', options['env'])
        self.assertNotIn('DB_MANGOS_PASSWORD', options['env'])
        self.assertNotIn('DB_REALMWEB_PASSWORD', options['env'])
        self.assertNotIn('SOAP_ADMIN_PASSWORD', options['env'])
        self.assertEqual(options['env']['HOME'], '/home/mangos')

    def test_database_failure_keeps_sensitive_diagnostics_private(self):
        with tempfile.TemporaryDirectory() as tmp:
            logfile = pathlib.Path(tmp) / 'database-error.log'
            result = subprocess.CompletedProcess([], 1, '', 'ERROR 1141 (42000): secret SQL text')
            with patch.object(runtime.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(RuntimeError, '1141') as error:
                    runtime.sql(runtime.settings(self.env()), 'SELECT 1', diagnostics=logfile)
            self.assertNotIn('secret SQL text', str(error.exception))
            self.assertEqual(logfile.read_text(), result.stderr)


if __name__ == '__main__':
    unittest.main()
