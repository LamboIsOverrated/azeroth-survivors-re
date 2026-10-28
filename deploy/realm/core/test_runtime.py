import importlib.util
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location('runtime', HERE / 'runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def env(self, **extra):
        return dict(DB_HOST='db.railway.internal', DB_ROOT_PASSWORD='Root_safe_123',
                    DB_MANGOS_PASSWORD='Core_safe_123', DB_REALMWEB_PASSWORD='Web_safe_123',
                    REALM_DOMAIN='realm-core.railway.internal', SOAP_ADMIN_USERNAME='REALMOPS',
                    SOAP_ADMIN_PASSWORD='OpsSafe123456', **extra)

    def test_config_rejects_injected_password_host_and_domain(self):
        for key, value in [('DB_MANGOS_PASSWORD', 'abc;def'), ('DB_HOST', 'x\nGameType=0'),
                           ('DB_ROOT_PASSWORD', "x' OR 1=1"), ('REALM_DOMAIN', 'https://x'),
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


if __name__ == '__main__':
    unittest.main()
