import importlib.util
from contextlib import ExitStack
import json
import os
import pathlib
import re
import secrets
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
                            patch.object(runtime, 'game_commands', return_value=[['fake-world']]),
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

    def test_compiled_capability_flags_accept_only_zero_or_one(self):
        for name in ('CORE_PLAYERBOTS_COMPILED', 'CORE_AHBOT_COMPILED', 'CORE_REALM_BRIDGE_COMPILED', 'REALM_BRIDGE_TEST_ENABLE',
                     'CORE_BROWSER_MOVEMENT_COMPILED', 'REALM_BROWSER_MOVEMENT_ENABLE'):
            for value in ('true', '2', '-1', '', 1):
                env = self.env()
                env[name] = value
                with self.subTest(name=name, value=value), self.assertRaisesRegex(ValueError, name):
                    runtime.settings(env)

    def test_browser_movement_requires_patched_capability_and_has_no_ban_actions(self):
        with self.assertRaisesRegex(ValueError, 'patched browser movement'):
            runtime.settings(self.env(REALM_BROWSER_MOVEMENT_ENABLE='1'))
        for compiled, enabled in (('0', '0'), ('1', '0'), ('1', '1')):
            with self.subTest(compiled=compiled, enabled=enabled), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                templates = root/'templates'
                templates.mkdir()
                for name in ('mangosd', 'realmd', 'anticheat', 'aiplayerbot', 'ahbot'):
                    (templates/(name+'.conf.dist')).write_text(
                        '[Config]\nEnable=0\nWarden.Enable=1\nMovement.Teleport.TickAction=24\n'
                        'Movement.BadFallReset.Penalty=11\n')
                cfg = runtime.settings(self.env(CORE_BROWSER_MOVEMENT_COMPILED=compiled,
                                               REALM_BROWSER_MOVEMENT_ENABLE=enabled))
                runtime.configure(cfg, root, templates)
                text = (root/'config/anticheat.conf').read_text()
                self.assertIn('Enable = '+enabled, text)
                if enabled == '1':
                    self.assertIn('Warden.Enable = 0', text)
                    self.assertIn('Movement.Teleport.TickAction = 1', text)
                    self.assertIn('Movement.BadFallReset.Penalty = 1', text)
                self.assertNotIn('REALM_BROWSER_MOVEMENT_ENABLE', runtime.game_options(cfg)['env'])

    def test_test_bridge_enable_requires_bot_free_build_and_never_passes_live_secrets(self):
        for playerbots, ahbot in (('1','1'), ('0','1'), ('1','0')):
            with self.subTest(playerbots=playerbots, ahbot=ahbot), self.assertRaisesRegex(ValueError, 'bot-free'):
                runtime.settings(self.env(CORE_PLAYERBOTS_COMPILED=playerbots,
                                          CORE_AHBOT_COMPILED=ahbot, CORE_REALM_BRIDGE_COMPILED='1',
                                          REALM_BRIDGE_TEST_ENABLE='1'))
        env = self.env(CORE_PLAYERBOTS_COMPILED='0', CORE_AHBOT_COMPILED='0',
                       CORE_REALM_BRIDGE_COMPILED='1', REALM_BRIDGE_TEST_ENABLE='1', LIVE_SETTLEMENT_ENABLE='1')
        cfg = runtime.settings(env)
        options = runtime.game_options(cfg)
        self.assertEqual(options['env']['REALM_BRIDGE_TEST_ENABLE'], '1')
        self.assertNotIn('LIVE_SETTLEMENT_ENABLE', options['env'])
        self.assertNotIn('DB_ROOT_PASSWORD', options['env'])
        self.assertNotIn('SOAP_ADMIN_PASSWORD', options['env'])
        self.assertEqual(runtime.game_options(self.env())['env']['REALM_BRIDGE_TEST_ENABLE'], '0')

    def test_bot_off_build_uses_only_core_templates_and_supported_arguments(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            templates = root/'templates'
            templates.mkdir()
            for name in ('mangosd', 'realmd', 'anticheat'):
                (templates/(name+'.conf.dist')).write_text('[Config]\n')
            cfg = runtime.settings(self.env(CORE_PLAYERBOTS_COMPILED='0', CORE_AHBOT_COMPILED='0'))
            runtime.configure(cfg, root, templates)
            self.assertFalse((root/'config/aiplayerbot.conf').exists())
            self.assertFalse((root/'config/ahbot.conf').exists())
            world = runtime.game_commands(cfg, root)[1]
            self.assertNotIn('-p', world)
            self.assertNotIn('-a', world)
            self.assertEqual(world, ['/opt/mangos/bin/mangosd', '-c', str(root/'config/mangosd.conf')])

    def test_declared_compiled_module_requires_its_template_before_config_writes(self):
        for missing in ('aiplayerbot', 'ahbot'):
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as tmp:
                root = pathlib.Path(tmp)
                templates = root/'templates'
                templates.mkdir()
                for name in ('mangosd', 'realmd', 'anticheat', 'aiplayerbot', 'ahbot'):
                    if name != missing:
                        (templates/(name+'.conf.dist')).write_text('[Config]\n')
                with self.assertRaisesRegex(RuntimeError, missing):
                    runtime.configure(runtime.settings(self.env()), root, templates)
                self.assertFalse((root/'config').exists())

    def test_compiled_capability_matrix_preserves_current_base_defaults(self):
        root = pathlib.Path('/realm-data')
        for playerbots, ahbot in (('0','0'), ('0','1'), ('1','0'), ('1','1')):
            cfg = runtime.settings(self.env(CORE_PLAYERBOTS_COMPILED=playerbots, CORE_AHBOT_COMPILED=ahbot))
            world = runtime.game_commands(cfg, root)[1]
            self.assertEqual('-p' in world, playerbots == '1')
            self.assertEqual('-a' in world, ahbot == '1')
        defaults = runtime.settings(self.env())
        self.assertEqual(defaults['CORE_PLAYERBOTS_COMPILED'], '1')
        self.assertEqual(defaults['CORE_AHBOT_COMPILED'], '1')
        self.assertEqual(defaults['CORE_REALM_BRIDGE_COMPILED'], '0')

    def test_bridge_compiled_and_enabled_capability_matrix(self):
        for compiled in ('0', '1'):
            for enabled in ('0', '1'):
                env = self.env(CORE_REALM_BRIDGE_COMPILED=compiled, REALM_BRIDGE_TEST_ENABLE=enabled,
                               CORE_PLAYERBOTS_COMPILED='0', CORE_AHBOT_COMPILED='0')
                if compiled == '0' and enabled == '1':
                    with self.assertRaisesRegex(ValueError, 'compiled bridge'):
                        runtime.settings(env)
                else:
                    self.assertEqual(runtime.settings(env)['CORE_REALM_BRIDGE_COMPILED'], compiled)
        self.assertIn('CORE_REALM_BRIDGE_COMPILED=0', (HERE/'Dockerfile').read_text())
        self.assertIn('CORE_REALM_BRIDGE_COMPILED=1', (HERE/'Dockerfile.bridge').read_text())

    def bridge_metadata(self):
        column = lambda kind, sqltype, length=0, collation='': {
            'data_type': kind, 'column_type': sqltype, 'nullable': 'NO',
            'length': length, 'collation': collation, 'extra': ''}
        identity = column('char', 'char(64)', 64, 'ascii_bin')
        payload = column('varchar', 'varchar(256)', 256, 'ascii_bin')
        return {'tables': dict.fromkeys(('characters', 'realm_bridge_inflight', 'realm_bridge_receipts'), 'InnoDB'),
                'columns': {
                    'characters': {'guid': column('int', 'int(11) unsigned'),
                                   'account': column('int', 'int(11) unsigned'),
                                   'money': column('int', 'int(11) unsigned'),
                                   'online': column('tinyint', 'tinyint(3) unsigned')},
                    'realm_bridge_inflight': {'operation_id': dict(identity), 'payload': dict(payload)},
                    'realm_bridge_receipts': {'operation_id': dict(identity), 'payload': dict(payload),
                                             'state': column('enum', "enum('applied','rejected')", 8, 'utf8mb3_general_ci'),
                                             'before_money': column('int', 'int(10) unsigned'),
                                             'after_money': column('int', 'int(10) unsigned'),
                                             'reason': column('varchar', 'varchar(32)', 32, 'utf8mb3_general_ci')}},
                'primary_keys': {'characters': [('guid', 0)],
                                 'realm_bridge_inflight': [('operation_id', 0)],
                                 'realm_bridge_receipts': [('operation_id', 0)]}}

    def test_bridge_schema_validation_rejects_incompatible_atomic_receipt_storage(self):
        mutations = [
            lambda m: m['tables'].pop('realm_bridge_inflight'),
            *[lambda m, table=t: m['tables'].__setitem__(table, 'MyISAM')
              for t in ('characters', 'realm_bridge_inflight', 'realm_bridge_receipts')],
            lambda m: m['primary_keys'].__setitem__('realm_bridge_receipts', [('operation_id', 0), ('payload', 0)]),
            lambda m: m['primary_keys'].__setitem__('realm_bridge_inflight', [('payload', 0)]),
            lambda m: m['primary_keys'].__setitem__('realm_bridge_receipts', [('operation_id', 16)]),
            lambda m: m['columns']['realm_bridge_receipts']['reason'].update(length=16, column_type='varchar(16)'),
            lambda m: m['columns']['realm_bridge_receipts'].pop('after_money'),
            lambda m: m['columns']['realm_bridge_receipts']['state'].update(column_type="enum('applied','rejected','unknown')"),
            lambda m: m['columns']['realm_bridge_receipts']['state'].update(column_type="enum('APPLIED','REJECTED')"),
            lambda m: m['columns']['realm_bridge_receipts']['before_money'].update(column_type='int(10)'),
            lambda m: m['columns']['realm_bridge_inflight']['operation_id'].update(collation='ascii_general_ci'),
            lambda m: m['columns']['realm_bridge_inflight']['payload'].update(nullable='YES'),
            lambda m: m['columns']['characters']['guid'].update(data_type='bigint', column_type='bigint unsigned'),
        ]
        runtime.validate_bridge_schema(self.bridge_metadata())
        for index, mutate in enumerate(mutations):
            metadata = self.bridge_metadata()
            mutate(metadata)
            with self.subTest(index=index), self.assertRaises(ValueError):
                runtime.validate_bridge_schema(metadata)

    def test_bridge_gate_is_read_only_mandatory_for_compiled_test_off_and_base_unchanged(self):
        for compiled in ('0', '1'):
            cfg = runtime.settings(self.env(CORE_REALM_BRIDGE_COMPILED=compiled))
            with tempfile.TemporaryDirectory() as directory, \
                    patch.object(runtime, 'bridge_schema_metadata', return_value=self.bridge_metadata()) as metadata:
                runtime.require_bridge_schema(cfg, pathlib.Path(directory))
                self.assertEqual(metadata.call_count, int(compiled))
        bad = self.bridge_metadata()
        bad['columns']['realm_bridge_receipts']['reason']['length'] = 16
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime, 'bridge_schema_metadata', return_value=bad), \
                patch.object(runtime, 'run_child') as launch:
            root = pathlib.Path(directory)
            with self.assertRaisesRegex(RuntimeError, '001-world-bridge.sql.*002-missing-character-reason.sql'):
                runtime.require_bridge_schema(runtime.settings(self.env(CORE_REALM_BRIDGE_COMPILED='1')), root)
            self.assertTrue((root/'logs/bridge-schema-error.log').is_file())
            launch.assert_not_called()

    def test_bootstrap_checks_compiled_schema_after_security_before_database_ready(self):
        cfg = runtime.settings(self.env(CORE_REALM_BRIDGE_COMPILED='1'))
        events = []
        def sql(cfg, statement):
            events.append('security' if statement.startswith('\nCREATE USER') else 'query')
            return '1'
        def gate(cfg, root):
            self.assertFalse(runtime.STATE['database'])
            self.assertEqual(events[-1], 'security')
            raise RuntimeError('reviewed schema required')
        with patch.object(runtime, 'sql', side_effect=sql), \
                patch.object(runtime, 'schema_ready', return_value=True), \
                patch.object(runtime, 'require_bridge_schema', side_effect=gate), \
                patch.dict(runtime.STATE, {'database': True}), \
                patch.object(runtime.STOP, 'is_set', return_value=False):
            with self.assertRaisesRegex(RuntimeError, 'reviewed schema'):
                runtime.bootstrap(cfg, pathlib.Path('/unused'))
            self.assertFalse(runtime.STATE['database'])

    def test_bridge_schema_is_rechecked_after_a_previous_valid_start(self):
        good, bad = self.bridge_metadata(), self.bridge_metadata()
        bad['tables']['realm_bridge_receipts'] = 'MyISAM'
        cfg = runtime.settings(self.env(CORE_REALM_BRIDGE_COMPILED='1', REALM_BRIDGE_TEST_ENABLE='0'))
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(runtime, 'bridge_schema_metadata', side_effect=[good, bad]) as metadata:
            runtime.require_bridge_schema(cfg, pathlib.Path(directory))
            with self.assertRaisesRegex(RuntimeError, 'compiled bridge schema'):
                runtime.require_bridge_schema(cfg, pathlib.Path(directory))
            self.assertEqual(metadata.call_count, 2, 'a prior success must not cache schema acceptance')

    @unittest.skipUnless(os.environ.get('CORE_BRIDGE_SCHEMA_FIXTURE') == '1',
                         'requires explicitly enabled disposable MariaDB fixture')
    def test_actual_mariadb_bridge_metadata_read_only_and_structural_failures(self):
        self.assertEqual(os.environ.get('RAILWAY_SERVICE_ID'), '09bb722b-e45b-4b32-923c-9198c8374fa6')
        cfg = self.env(CORE_REALM_BRIDGE_COMPILED='1')
        cfg.update(DB_HOST='127.0.0.1', DB_PORT='13307', DB_ROOT_PASSWORD=os.environ['MARIADB_ROOT_PASSWORD'])
        cfg = runtime.settings(cfg)
        create = """
CREATE TABLE characters (guid INT UNSIGNED NOT NULL PRIMARY KEY, account INT UNSIGNED NOT NULL,
 money INT UNSIGNED NOT NULL, online TINYINT UNSIGNED NOT NULL) ENGINE=InnoDB;
CREATE TABLE realm_bridge_inflight (operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 payload VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL) ENGINE=InnoDB;
CREATE TABLE realm_bridge_receipts (operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
 payload VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, state ENUM('applied','rejected') NOT NULL,
 before_money INT UNSIGNED NOT NULL, after_money INT UNSIGNED NOT NULL, reason VARCHAR(32) NOT NULL) ENGINE=InnoDB;
"""
        mutations = [None, 'DROP TABLE realm_bridge_inflight',
                     'ALTER TABLE characters ENGINE=MyISAM',
                     'ALTER TABLE realm_bridge_inflight ENGINE=MyISAM',
                     'ALTER TABLE realm_bridge_receipts ENGINE=MyISAM',
                     'ALTER TABLE realm_bridge_receipts DROP PRIMARY KEY, ADD PRIMARY KEY(operation_id,payload)',
                     'ALTER TABLE realm_bridge_receipts MODIFY reason VARCHAR(16) NOT NULL',
                     'ALTER TABLE realm_bridge_receipts DROP COLUMN after_money',
                     "ALTER TABLE realm_bridge_receipts MODIFY state ENUM('applied','rejected','unknown') NOT NULL",
                     'ALTER TABLE realm_bridge_receipts MODIFY before_money INT NOT NULL',
                     'ALTER TABLE realm_bridge_inflight MODIFY operation_id CHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL']
        with tempfile.TemporaryDirectory() as directory:
            diagnostics = pathlib.Path(directory)/'private-database-error.log'
            actual_sql = runtime.sql
            def query(statement):
                return actual_sql(cfg, statement, diagnostics=diagnostics)
            for mutation in mutations:
                database = 'realm_bridge_schema_fixture_' + secrets.token_hex(6)
                self.assertRegex(database, r'^realm_bridge_schema_fixture_[0-9a-f]{12}$')
                try:
                    query(f'CREATE DATABASE `{database}`; USE `{database}`;' + create)
                    if mutation:
                        query(f'USE `{database}`;' + mutation)
                    before = query(f"SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA='{database}' ORDER BY TABLE_NAME")
                    reads = []
                    def read_only(cfg, statement, **kwargs):
                        self.assertTrue(statement.startswith('SELECT '))
                        self.assertNotIn(';', statement)
                        reads.append(statement)
                        return actual_sql(cfg, statement, **kwargs)
                    with self.subTest(mutation=mutation), patch.object(runtime, 'sql', side_effect=read_only):
                        metadata = runtime.bridge_schema_metadata(cfg, database, diagnostics)
                        if mutation:
                            with self.assertRaises(ValueError):
                                runtime.validate_bridge_schema(metadata)
                        else:
                            runtime.validate_bridge_schema(metadata)
                        self.assertEqual(len(reads), 3)
                    self.assertEqual(before, query(f"SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA='{database}' ORDER BY TABLE_NAME"))
                finally:
                    self.assertTrue(re.fullmatch(r'realm_bridge_schema_fixture_[0-9a-f]{12}', database))
                    query(f'DROP DATABASE IF EXISTS `{database}`')

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
        self.assertEqual(sql.count('GRANT DROP'), 1)
        self.assertIn("GRANT DROP ON classiccharacters.game_event_status TO 'mangos'@'%';", sql)
        self.assertNotIn('GRANT ALL', sql)
        self.assertEqual(sql.count("'Azeroth TEST PvP'"), 2)
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
            self.assertFalse(runtime.extraction_ready(root), 'legacy canaries cannot attest complete world data')

    def test_existing_complete_marker_never_blesses_corrupt_skipped_extraction(self):
        for corrupt in (False, True):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                data = root / 'data'
                for name in ('dbc/Map.dbc', 'maps/000.map', 'vmaps/model.vmo', 'mmaps/000.mmap'):
                    path = data / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(b'accepted')
                inventory = runtime.world_inventory
                profile = {'version': 1, 'core': runtime.CORE, 'inputs': [], 'tools': {},
                           'outputs': inventory.summary(inventory.scan_outputs(data))}
                (root / 'extraction').mkdir()
                marker = root / 'extraction/complete.json'
                legacy = '{"core":"' + runtime.CORE + '"}'
                marker.write_text(legacy)
                if corrupt:
                    (data / 'vmaps/model.vmo').write_bytes(b'corrupt!')
                with patch.object(inventory, 'load_profile', return_value=profile), \
                        patch.object(inventory, 'verify_sources') as sources, \
                        patch.object(runtime, 'run_child') as run:
                    if corrupt:
                        with self.assertRaisesRegex(RuntimeError, 'inventory'):
                            runtime.extract({}, root)
                        self.assertEqual(marker.read_text(), legacy)
                    else:
                        runtime.extract({}, root)
                        inventory.verify_outputs(data, marker, profile)
                    sources.assert_called_once()
                    run.assert_not_called()

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
