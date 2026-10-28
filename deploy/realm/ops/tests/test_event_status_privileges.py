"""Optional actual-MariaDB grant regression; creates only fresh named fixtures."""
import os
from pathlib import Path
import re
import secrets
import subprocess
import unittest
import uuid


@unittest.skipUnless(os.environ.get('REALM_PERMISSION_FIXTURE') == '1',
                     'requires explicitly enabled disposable MariaDB fixture')
class EventStatusPrivileges(unittest.TestCase):
    def test_table_only_drop_allows_stock_cleanup_and_denies_other_ddl(self):
        # Refuse the real realm database: the operator must run inside the known
        # disposable restore service against its nondefault loopback port.
        self.assertEqual(os.environ.get('RAILWAY_SERVICE_ID'), '09bb722b-e45b-4b32-923c-9198c8374fa6')
        suffix = uuid.uuid4().hex[:12]
        database = 'realm_ops_permission_' + suffix
        user = 'ops_perm_' + suffix
        self.assertRegex(database, r'^realm_ops_permission_[0-9a-f]{12}$')
        self.assertRegex(user, r'^ops_perm_[0-9a-f]{12}$')
        password = secrets.token_urlsafe(24)
        base = ['mariadb', '--protocol=tcp', '--host=127.0.0.1', '--port=13307',
                '--batch', '--skip-column-names']
        root_env = dict(os.environ, MYSQL_PWD=os.environ['MARIADB_ROOT_PASSWORD'])
        user_env = dict(os.environ, MYSQL_PWD=password)

        def query(statement, *, as_user=False):
            return subprocess.run([*base, '--user=' + (user if as_user else 'root')],
                                  input=statement, env=user_env if as_user else root_env,
                                  text=True, capture_output=True, timeout=15)

        def root_query(statement):
            result = query(statement)
            self.assertEqual(result.returncode, 0, 'fixture administrator SQL failed; diagnostics suppressed')
            return result.stdout.strip()

        try:
            root_query(f'CREATE DATABASE `{database}`; '
                       f'CREATE TABLE `{database}`.game_event_status (event SMALLINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB; '
                       f'CREATE TABLE `{database}`.protected_characters (guid INT PRIMARY KEY) ENGINE=InnoDB; '
                       f'INSERT INTO `{database}`.game_event_status VALUES (12),(13); '
                       f'INSERT INTO `{database}`.protected_characters VALUES (1); '
                       f"CREATE USER '{user}'@'127.0.0.1' IDENTIFIED BY '{password}'; "
                       f"GRANT SELECT,INSERT,UPDATE,DELETE ON `{database}`.* TO '{user}'@'127.0.0.1';")
            denied = query(f'TRUNCATE TABLE `{database}`.game_event_status', as_user=True)
            self.assertNotEqual(denied.returncode, 0)
            self.assertIn('1142', denied.stderr)
            # A source DML change is another valid option, without adding privilege.
            self.assertEqual(query(f'DELETE FROM `{database}`.game_event_status', as_user=True).returncode, 0)
            root_query(f'INSERT INTO `{database}`.game_event_status VALUES (12),(13)')
            grant = (Path(__file__).resolve().parents[1] / 'event-status-runtime-grant.sql').read_text()
            grant = grant.replace('`classiccharacters`', '`' + database + '`').replace("'mangos'@'%'", "'" + user + "'@'127.0.0.1'")
            rendered = '\n'.join(line for line in grant.splitlines() if not line.lstrip().startswith('--'))
            self.assertNotIn('classiccharacters', rendered.lower(), 'unsafe fixture schema substitution')
            self.assertNotIn("'mangos'@", rendered.lower(), 'unsafe fixture account substitution')
            # The real SQL artifact is executed; broader schema-wide DROP would
            # fail the protected-table checks below.
            root_query(grant)
            cleaned = query(f'TRUNCATE TABLE `{database}`.game_event_status', as_user=True)
            self.assertEqual(cleaned.returncode, 0, 'table-scoped grant did not permit stock cleanup')
            self.assertEqual(root_query(f'SELECT COUNT(*) FROM `{database}`.game_event_status'), '0')
            self.assertEqual(query(f'INSERT INTO `{database}`.game_event_status VALUES (12),(13)', as_user=True).returncode, 0)
            for statement in (f'DROP TABLE `{database}`.protected_characters',
                              f'ALTER TABLE `{database}`.protected_characters ADD COLUMN unwanted INT',
                              f'CREATE TABLE `{database}`.unwanted (id INT)',
                              f'DROP DATABASE `{database}`'):
                with self.subTest(statement=statement.split()[0]):
                    result = query(statement, as_user=True)
                    self.assertNotEqual(result.returncode, 0)
            self.assertEqual(root_query(f'SELECT COUNT(*) FROM `{database}`.protected_characters'), '1')
        finally:
            # Exact generated identifiers only; never enumerate or reuse schemas.
            self.assertTrue(re.fullmatch(r'realm_ops_permission_[0-9a-f]{12}', database))
            self.assertTrue(re.fullmatch(r'ops_perm_[0-9a-f]{12}', user))
            root_query(f'DROP DATABASE IF EXISTS `{database}`; DROP USER IF EXISTS \'{user}\'@\'127.0.0.1\';')


if __name__ == '__main__':
    unittest.main()
