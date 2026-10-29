"""Private CMaNGOS supervisor. Listener readiness is not gameplay verification."""
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import world_inventory

SCHEMAS = ('classicrealmd', 'classiccharacters', 'classicmangos', 'classiclogs')
CORE = 'de8f72993b9e1faa1bf92dd5505f3daec5cea3ce'
STATE = dict(phase='starting', maintenance=False, database=False, data=False,
             login=False, world=False, soap=False, ready=False)
STOP = threading.Event()
CHILDREN = []


def compiled_capabilities(env):
    capabilities = {}
    for name, default in [('CORE_PLAYERBOTS_COMPILED', '1'), ('CORE_AHBOT_COMPILED', '1'),
                          ('CORE_REALM_BRIDGE_COMPILED', '0'), ('REALM_BRIDGE_TEST_ENABLE', '0'),
                          ('CORE_BROWSER_MOVEMENT_COMPILED', '0'),
                          ('REALM_BROWSER_MOVEMENT_ENABLE', '0')]:
        value = env.get(name, default)
        if value not in ('0', '1'):
            raise ValueError(name + ' must be 0 or 1')
        capabilities[name] = value
    if capabilities['REALM_BRIDGE_TEST_ENABLE'] == '1' and capabilities['CORE_REALM_BRIDGE_COMPILED'] != '1':
        raise ValueError('REALM_BRIDGE_TEST_ENABLE requires a compiled bridge build')
    if capabilities['REALM_BRIDGE_TEST_ENABLE'] == '1' and any(
            capabilities[name] != '0' for name in ('CORE_PLAYERBOTS_COMPILED', 'CORE_AHBOT_COMPILED')):
        raise ValueError('REALM_BRIDGE_TEST_ENABLE requires a declared bot-free compiled build')
    if capabilities['REALM_BROWSER_MOVEMENT_ENABLE'] == '1' and capabilities['CORE_BROWSER_MOVEMENT_COMPILED'] != '1':
        raise ValueError('REALM_BROWSER_MOVEMENT_ENABLE requires a patched browser movement build')
    return capabilities


def settings(env):
    cfg = dict(env)
    cfg.update(compiled_capabilities(env))
    for key in ('DB_ROOT_PASSWORD', 'DB_MANGOS_PASSWORD', 'DB_REALMWEB_PASSWORD'):
        if not re.fullmatch(r'[A-Za-z0-9_-]{12,128}', cfg.get(key, '')):
            raise ValueError(key + ' must be 12-128 alphanumeric/_/- characters')
    for key, default in [('DB_HOST', 'realm-db.railway.internal'), ('REALM_DOMAIN', 'realm-core.railway.internal')]:
        cfg.setdefault(key, default)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', cfg[key]):
            raise ValueError(key + ' must be a hostname')
    if len(cfg['REALM_DOMAIN']) > 32:
        raise ValueError('REALM_DOMAIN must fit Classic realmlist.address (32 chars); use private core DNS')
    for key, default in [('DB_PORT', '3306'), ('PORT', '8080'), ('EXTRACT_THREADS', '2')]:
        value = str(cfg.get(key, default))
        if not value.isdigit() or not 1 <= int(value) <= (64 if key == 'EXTRACT_THREADS' else 65535):
            raise ValueError('invalid ' + key)
        cfg[key] = value
    username = cfg.get('SOAP_ADMIN_USERNAME', '')
    if not re.fullmatch(r'[A-Z][A-Z0-9_]{2,15}', username) or username in ('ADMINISTRATOR', 'GAMEMASTER', 'MODERATOR', 'PLAYER'):
        raise ValueError('SOAP_ADMIN_USERNAME must be a separate uppercase operator account (3-16 chars)')
    if not re.fullmatch(r'[A-Za-z0-9]{12,16}', cfg.get('SOAP_ADMIN_PASSWORD', '')):
        raise ValueError('SOAP_ADMIN_PASSWORD must be 12-16 alphanumeric characters (Vanilla limit)')
    return cfg


def write_private(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(content, encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def replace_config(template, values):
    for key, value in values.items():
        pattern = r'^\s*' + re.escape(key) + r'\s*=.*$'
        line = key + ' = ' + str(value)
        if re.search(pattern, template, re.MULTILINE):
            template = re.sub(pattern, lambda match: line, template, flags=re.MULTILINE)
        else:
            template += '\n' + line + '\n'
    return template


def configure(cfg, root, templates=Path('/opt/mangos/etc')):
    capabilities = compiled_capabilities(cfg)
    connection = f'{cfg["DB_HOST"]};{cfg["DB_PORT"]};mangos;{cfg["DB_MANGOS_PASSWORD"]}'
    common = {'LogsDir': f'"{root}/logs"'}
    values = {
        'mangosd': dict(common, LoginDatabaseInfo=f'"{connection};classicrealmd"',
                       WorldDatabaseInfo=f'"{connection};classicmangos"', CharacterDatabaseInfo=f'"{connection};classiccharacters"',
                       LogsDatabaseInfo=f'"{connection};classiclogs"', DataDir=f'"{root}/data"', BindIP='"0.0.0.0"',
                       WorldServerPort=8085, GameType=1, RealmID=1, PlayerLimit=40,
                       **{'Console.Enable': 0, 'SOAP.Enabled': 1, 'SOAP.IP': '0.0.0.0', 'SOAP.Port': 7878, 'Ra.Enable': 0, 'mmap.enabled': 1}),
        'realmd': dict(common, LoginDatabaseInfo=f'"{connection};classicrealmd"', BindIP='"0.0.0.0"', RealmServerPort=3724,
                      **{'WrongPass.MaxCount': 0}),
        'ahbot': {'AuctionHouseBot.Chance.Sell': 0, 'AuctionHouseBot.Chance.Buy': 0},
        'aiplayerbot': {'AiPlayerbot.Enabled': 0, 'AiPlayerbot.MinRandomBots': 0, 'AiPlayerbot.MaxRandomBots': 0,
                       'AiPlayerbot.RandomBotAutologin': 0},
        'anticheat': {'Enable': 0}}
    if capabilities['REALM_BROWSER_MOVEMENT_ENABLE'] == '1':
        # Only the exact source carry can separate Warden from movement checks.
        # Enforcement rejects packets; heuristic response rules never ban or kick.
        anticheat = values['anticheat']
        anticheat.update({'Enable': 1, 'Warden.Enable': 0, 'Antispam.Enable': 0,
                          'Movement.SpeedHack.Enable': 1, 'Movement.UseExtrapolation': 0,
                          'Movement.BadFallReset.Penalty': 1})
        for detector in ('WallClimb', 'WaterWalk', 'SlowFall', 'FlyHack', 'Forbidden', 'MultiJump',
                         'TimeBack', 'FastJump', 'JumpSpeedChange', 'NullClientTime', 'RootMove',
                         'Explore', 'ExploreHigh', 'OverspeedZ', 'HeartbeatSkip', 'ClockDesync',
                         'FakeTransport', 'TeleToTransport', 'Teleport', 'TeleportFar', 'FixedZ', 'BadOrderAck'):
            for suffix, value in (('TickCount', 1), ('TickAction', 1), ('TotalCount', 0), ('TotalAction', 0)):
                anticheat['Movement.' + detector + '.' + suffix] = value
    for flag, name in [('CORE_PLAYERBOTS_COMPILED', 'aiplayerbot'), ('CORE_AHBOT_COMPILED', 'ahbot')]:
        if capabilities[flag] == '0':
            del values[name]
    # Validate the declared image capabilities before changing any existing
    # configuration. A missing compiled-module template is an image error.
    for name in values:
        if not (templates / (name + '.conf.dist')).is_file():
            raise RuntimeError('Required compiled configuration template missing: ' + name + '.conf.dist')
    for name, updates in values.items():
        template = templates / (name + '.conf.dist')
        write_private(root / 'config' / (name + '.conf'), replace_config(template.read_text(), updates))
    (root / 'logs').mkdir(exist_ok=True)


def data_ready(data):
    return all(any(p.is_file() and p.stat().st_size > 0 for p in (data / folder).glob(pattern))
               for folder, pattern in [('dbc', '*.dbc'), ('maps', '*.map'), ('vmaps', '*.vmtree'), ('mmaps', '*.mmap')])


def extraction_ready(root):
    if not (root / 'extraction/complete.json').is_file():
        return False
    try:
        STATE['phase'] = 'verifying-complete-world-data'
        world_inventory.verify(root, expected_core=CORE)
        return True
    except (OSError, ValueError, RuntimeError, KeyError, TypeError):
        return False


def bootstrap_action(counts, ready):
    if ready:
        return 'preserve'
    if not any(counts.values()):
        return 'install'
    raise RuntimeError('existing or interrupted databases preserved; schema repair required before startup')


def srp(username, password, salt=None):
    """Matches CMaNGOS SRP6.cpp and BigNumber.cpp database byte order."""
    salt = salt or secrets.token_hex(32).upper()
    number = int(salt, 16)
    salt_bytes = number.to_bytes((number.bit_length() + 7) // 8, 'little')
    identity = hashlib.sha1((username.upper() + ':' + password.upper()).encode('ascii')).digest()
    exponent = int.from_bytes(hashlib.sha1(salt_bytes + identity).digest(), 'little')
    modulus = int('894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7', 16)
    return salt, format(pow(7, exponent, modulus), 'X')


def security_sql(cfg):
    salt, verifier = srp(cfg['SOAP_ADMIN_USERNAME'], cfg['SOAP_ADMIN_PASSWORD'])
    return f"""
CREATE USER IF NOT EXISTS 'mangos'@'%' IDENTIFIED BY '{cfg['DB_MANGOS_PASSWORD']}';
ALTER USER 'mangos'@'%' IDENTIFIED BY '{cfg['DB_MANGOS_PASSWORD']}';
CREATE USER IF NOT EXISTS 'realmweb'@'%' IDENTIFIED BY '{cfg['DB_REALMWEB_PASSWORD']}';
ALTER USER 'realmweb'@'%' IDENTIFIED BY '{cfg['DB_REALMWEB_PASSWORD']}';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'mangos'@'%';
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'realmweb'@'%';
GRANT SELECT,INSERT,UPDATE,DELETE ON classicrealmd.* TO 'mangos'@'%';
GRANT SELECT,INSERT,UPDATE,DELETE ON classiccharacters.* TO 'mangos'@'%';
-- The pinned GameEventMgr startup uses TRUNCATE for this bookkeeping table.
-- Keep DROP scoped to that table; no other runtime DDL is authorized.
GRANT DROP ON classiccharacters.game_event_status TO 'mangos'@'%';
-- World::ResetWeeklyQuests uses the same pinned TRUNCATE bookkeeping cleanup.
GRANT DROP ON classiccharacters.character_queststatus_weekly TO 'mangos'@'%';
GRANT SELECT,INSERT,UPDATE,DELETE,CREATE TEMPORARY TABLES ON classicmangos.* TO 'mangos'@'%';
GRANT SELECT,INSERT,UPDATE,DELETE ON classiclogs.* TO 'mangos'@'%';
GRANT SELECT ON classicrealmd.* TO 'realmweb'@'%';
GRANT SELECT ON classiccharacters.* TO 'realmweb'@'%';
UPDATE classicrealmd.account SET locked=1,gmlevel=0,sessionkey='',v='',s=''
 WHERE username IN ('ADMINISTRATOR','GAMEMASTER','MODERATOR','PLAYER');
INSERT IGNORE INTO classicrealmd.account (username,gmlevel,v,s)
 VALUES ('{cfg['SOAP_ADMIN_USERNAME']}',3,'{verifier}','{salt}');
UPDATE classicrealmd.account SET gmlevel=3,v='{verifier}',s='{salt}',sessionkey='',locked=0
 WHERE username='{cfg['SOAP_ADMIN_USERNAME']}';
INSERT IGNORE INTO classicrealmd.realmlist
 (id,name,address,port,icon,realmflags,timezone,allowedSecurityLevel,population,realmbuilds)
 VALUES (1,'Azeroth TEST PvP','{cfg['REALM_DOMAIN']}',8085,1,0,8,0,0,'5875');
UPDATE classicrealmd.realmlist SET name='Azeroth TEST PvP',address='{cfg['REALM_DOMAIN']}',
 port=8085,icon=1,realmbuilds='5875',allowedSecurityLevel=0 WHERE id=1;
"""


def sql(cfg, statement, diagnostics=Path('/realm-data/logs/database-error.log')):
    command = ['mariadb', '--protocol=tcp', '-h', cfg['DB_HOST'], '-P', cfg['DB_PORT'], '-uroot',
               '--connect-timeout=5', '--batch', '--skip-column-names']
    result = subprocess.run(command, input=statement, text=True, capture_output=True,
                            env=dict(os.environ, MYSQL_PWD=cfg['DB_ROOT_PASSWORD']))
    if result.returncode:
        write_private(diagnostics, result.stderr)
        match = re.search(r'ERROR\s+(\d+)', result.stderr)
        code = match.group(1) if match else 'unknown'
        raise RuntimeError('database command failed (code ' + code + '); inspect private database diagnostics')
    return result.stdout.strip()


def schema_ready(cfg):
    checks = [('classicrealmd', 'account'), ('classicrealmd', 'realmlist'), ('classicrealmd', 'realmd_db_version'),
              ('classiccharacters', 'characters'), ('classiccharacters', 'character_db_version'),
              ('classicmangos', 'creature_template'), ('classicmangos', 'db_version'), ('classiclogs', 'logs_db_version')]
    for schema, table in checks:
        if sql(cfg, f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{schema}' AND table_name='{table}'") != '1':
            return False
    return int(sql(cfg, 'SELECT COUNT(*) FROM classicmangos.creature_template')) > 0


def bridge_schema_metadata(cfg, schema='classiccharacters', diagnostics=Path('/realm-data/logs/database-error.log')):
    """Read metadata only; also usable against an explicitly named disposable fixture."""
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', schema):
        raise ValueError('invalid bridge schema identifier')
    where = (f"TABLE_SCHEMA='{schema}' AND TABLE_NAME IN "
             "('characters','realm_bridge_inflight','realm_bridge_receipts')")
    tables = sql(cfg, 'SELECT TABLE_NAME,COALESCE(ENGINE,\'\') FROM information_schema.TABLES WHERE '
                 + where + ' ORDER BY TABLE_NAME', diagnostics=diagnostics)
    columns = sql(cfg, "SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,"
                  "COALESCE(CHARACTER_MAXIMUM_LENGTH,0),COALESCE(COLLATION_NAME,''),EXTRA,'end' "
                  'FROM information_schema.COLUMNS WHERE ' + where + ' ORDER BY TABLE_NAME,ORDINAL_POSITION',
                  diagnostics=diagnostics)
    keys = sql(cfg, 'SELECT TABLE_NAME,COLUMN_NAME,COALESCE(SUB_PART,0) FROM information_schema.STATISTICS WHERE '
               + where + " AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME,SEQ_IN_INDEX", diagnostics=diagnostics)
    metadata = {'tables': {}, 'columns': {}, 'primary_keys': {}}
    for line in tables.splitlines():
        table, engine = line.split('\t')
        metadata['tables'][table] = engine
    for line in columns.splitlines():
        table, name, kind, definition, nullable, length, collation, extra, end = line.split('\t')
        if end != 'end':
            raise ValueError('invalid bridge column metadata')
        metadata['columns'].setdefault(table, {})[name] = dict(
            data_type=kind, column_type=definition, nullable=nullable, length=int(length),
            collation=collation, extra=extra)
    for line in keys.splitlines():
        table, name, prefix = line.split('\t')
        metadata['primary_keys'].setdefault(table, []).append((name, int(prefix)))
    return metadata


def validate_bridge_schema(metadata):
    """Validate the storage contract used by the compiled FIFO and login fence."""
    required = {
        'characters': {'guid': 'uint', 'account': 'uint', 'money': 'uint', 'online': 'utinyint'},
        'realm_bridge_inflight': {'operation_id': 'identity', 'payload': 'payload'},
        'realm_bridge_receipts': {'operation_id': 'identity', 'payload': 'payload', 'state': 'state',
                                  'before_money': 'uint', 'after_money': 'uint', 'reason': 'reason'}}
    for table, fields in required.items():
        if metadata['tables'].get(table, '').lower() != 'innodb':
            raise ValueError(table + ' must exist and use InnoDB')
        primary = 'guid' if table == 'characters' else 'operation_id'
        if metadata['primary_keys'].get(table) != [(primary, 0)]:
            raise ValueError(table + ' requires its complete single-column primary key')
        columns = metadata['columns'].get(table, {})
        if table != 'characters' and set(columns) != set(fields):
            raise ValueError(table + ' has missing or unexpected columns')
        for name, rule in fields.items():
            column = columns.get(name)
            if not column or column['nullable'] != 'NO' or column['extra']:
                raise ValueError(table + '.' + name + ' must be present, stored and NOT NULL')
            kind, definition = column['data_type'].lower(), column['column_type'].lower()
            valid = False
            if rule in ('uint', 'utinyint'):
                expected = 'int' if rule == 'uint' else 'tinyint'
                valid = kind == expected and re.fullmatch(expected + r'(\(\d+\))? unsigned', definition)
            elif rule in ('identity', 'payload'):
                expected, length = ('char', 64) if rule == 'identity' else ('varchar', 256)
                valid = (kind == expected and definition == f'{expected}({length})'
                         and column['length'] == length and column['collation'] == 'ascii_bin')
            elif rule == 'state':
                valid = kind == 'enum' and column['column_type'] == "enum('applied','rejected')"
            elif rule == 'reason':
                valid = (kind == 'varchar' and column['length'] >= 32
                         and definition == f"varchar({column['length']})")
            if not valid:
                raise ValueError(table + '.' + name + ' has an incompatible type, length or collation')


def require_bridge_schema(cfg, root):
    # The patched login fence reads these tables even with TEST commands off.
    # Never install/upgrade bridge tables or convert character engines here.
    if compiled_capabilities(cfg)['CORE_REALM_BRIDGE_COMPILED'] == '0':
        return
    try:
        validate_bridge_schema(bridge_schema_metadata(cfg, diagnostics=root/'logs/database-error.log'))
    except (RuntimeError, ValueError, KeyError, TypeError) as error:
        write_private(root/'logs/bridge-schema-error.log', str(error) + '\n')
        raise RuntimeError(
            'compiled bridge schema incompatible; keep gameplay stopped and have the operator review '
            '/opt/railway-core/source/bridge/core/001-world-bridge.sql and '
            '002-missing-character-reason.sql during maintenance; no automatic schema repair was attempted') from None


def bootstrap(cfg, root):
    STATE['database'] = False
    STATE['phase'] = 'database-wait'
    while not STOP.is_set():
        try:
            sql(cfg, 'SELECT 1')
            break
        except RuntimeError:
            STOP.wait(3)
    if STOP.is_set():
        return
    counts = {name: int(sql(cfg, f"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='{name}'")) for name in SCHEMAS}
    if bootstrap_action(counts, schema_ready(cfg)) == 'install':
        STATE['phase'] = 'database-install'
        directory = Path('/opt/src/classic-db')
        config = directory / 'InstallFullDB.config'
        values = dict(MYSQL_HOST=cfg['DB_HOST'], MYSQL_PORT=cfg['DB_PORT'], MYSQL_USERNAME='mangos',
                      MYSQL_PASSWORD=cfg['DB_MANGOS_PASSWORD'], MYSQL_USERIP='%', MYSQL_COLSTAT='',
                      WORLD_DB_NAME='classicmangos', REALM_DB_NAME='classicrealmd', CHAR_DB_NAME='classiccharacters',
                      LOGS_DB_NAME='classiclogs', MYSQL_PATH='/usr/bin/mariadb', MYSQL_DUMP_PATH='/usr/bin/mariadb-dump',
                      CORE_PATH='/opt/src/mangos-classic', FORCE_WAIT='NO', DEV_UPDATES='NO', AHBOT='NO', PLAYERBOTS_DB='NO')
        write_private(config, ''.join(f'{key}="{value}"\n' for key, value in values.items()))
        try:
            run_child(['bash', '-c', 'exec bash InstallFullDB.sh -InstallAll root "$DB_ROOT_PASSWORD" DeleteAll'],
                      cwd=directory, env=dict(os.environ, DB_ROOT_PASSWORD=cfg['DB_ROOT_PASSWORD']))
        finally:
            config.unlink(missing_ok=True)
        if not schema_ready(cfg):
            raise RuntimeError('database installation incomplete; existing data preserved for repair')
    sql(cfg, security_sql(cfg))
    require_bridge_schema(cfg, root)
    STATE['database'] = True


def run_child(command, **kwargs):
    process = subprocess.Popen(command, start_new_session=(os.name != 'nt'), **kwargs)
    CHILDREN.append(process)
    try:
        code = process.wait()
        if code:
            raise RuntimeError('initialization command failed with exit ' + str(code))
    finally:
        CHILDREN.remove(process)


def extract(cfg, root):
    data, client = root / 'data', root / 'client'
    tools = Path('/opt/mangos/bin/tools')
    config = Path('/opt/src/mangos-classic/contrib/extractor_scripts/config.json')
    profile = world_inventory.load_profile()
    if profile['core'] != CORE:
        raise RuntimeError('extraction profile does not match the pinned core')
    world_inventory.verify_sources(client, tools, config, profile)
    stages = root / 'extraction'
    stages.mkdir(exist_ok=True)
    if (stages / 'complete.json').exists():
        # A legacy or damaged marker is upgraded only when every source/tool and
        # output byte equals the independently accepted extraction. Never bless
        # partial outputs merely because old stage markers or canaries exist.
        world_inventory.seal_outputs(data, stages / 'complete.json', profile)
        STATE['data'] = True
        STATE['phase'] = 'extraction-verified'
        return
    data.mkdir(parents=True, exist_ok=True)
    fingerprint = world_inventory.profile_id(profile)
    plan = [('dbc-maps', [str(tools / 'ad'), '-i', str(client), '-o', str(data)]),
            ('vmap-extract', [str(tools / 'vmap_extractor'), '-d', str(client / 'Data'), '-o', str(data)]),
            ('vmap-assemble', [str(tools / 'vmap_assembler'), str(data / 'Buildings'), str(data / 'vmaps')]),
            ('mmaps', [str(tools / 'MoveMapGen'), '--silent', '--configInputPath', str(tools / 'config.json'),
                       '--offMeshInput', str(tools / 'offmesh.txt'), '--workdir', str(data) + '/',
                       '--threads', cfg['EXTRACT_THREADS'], '--buildGameObjects'])]
    shutil.copyfile(config, tools / 'config.json')
    for name, command in plan:
        if STOP.is_set():
            return
        marker = stages / (name + '.complete')
        if marker.exists() and marker.read_text() == fingerprint:
            continue
        STATE['phase'] = 'extract-' + name
        print(STATE['phase'], flush=True)
        (data / 'vmaps').mkdir(exist_ok=True)
        (data / 'mmaps').mkdir(exist_ok=True)
        with (root / 'logs' / ('extract-' + name + '.log')).open('a') as logfile:
            run_child(command, cwd=data, stdout=logfile, stderr=subprocess.STDOUT)
        write_private(marker, fingerprint)
    if not data_ready(data):
        raise RuntimeError('extractors exited but required data outputs missing')
    world_inventory.seal_outputs(data, stages / 'complete.json', profile)
    STATE['data'] = True
    STATE['phase'] = 'extraction-complete'


def stop_children(children, grace=45):
    for process in list(children):
        if process.poll() is None:
            if os.name == 'nt':
                process.terminate()
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
    deadline = time.monotonic() + grace
    for process in list(children):
        try:
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            if os.name == 'nt':
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.4):
            return True
    except OSError:
        return False


class NoSoapRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def parse_world_health(raw):
    """Accept only the read-only v1 snapshot shared with the compiled login gate."""
    if len(raw) > 65536:
        raise ValueError('world health response too large')
    try:
        text = raw.decode('utf-8')
        if '\0' in text or '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
            raise ValueError('unsupported world health XML')
        envelope = ET.fromstring(text)
        elements = list(envelope.iter())
        if envelope.tag.rsplit('}', 1)[-1] != 'Envelope' or any(
                element.tag.rsplit('}', 1)[-1] == 'Fault' for element in elements):
            raise ValueError('world health SOAP fault or envelope mismatch')
        results = [element for element in elements if element.tag.rsplit('}', 1)[-1] == 'result']
        if len(results) != 1 or len(results[0]):
            raise ValueError('ambiguous world health result')
        value = (results[0].text or '').strip()
        prefix = 'REALM_BRIDGE_HEALTH_V1 '
        if not value.startswith(prefix):
            raise ValueError('world health version prefix missing')
        def unique_fields(pairs):
            if len({key for key, _ in pairs}) != len(pairs):
                raise ValueError('duplicate world health field')
            return dict(pairs)
        payload = json.loads(value[len(prefix):], object_pairs_hook=unique_fields)
    except (UnicodeError, ET.ParseError, json.JSONDecodeError) as error:
        raise ValueError('invalid world health response') from error
    fields = {'version', 'loginPermitted', 'writerFailed', 'inflightQueryOk', 'inflight', 'reason'}
    if not isinstance(payload, dict) or set(payload) != fields or type(payload['version']) is not int or payload['version'] != 1:
        raise ValueError('world health fields/version mismatch')
    if any(type(payload[key]) is not bool for key in ('loginPermitted', 'writerFailed', 'inflightQueryOk')):
        raise ValueError('world health boolean mismatch')
    count = payload['inflight']
    if payload['inflightQueryOk']:
        if (not isinstance(count, str) or not re.fullmatch(r'0|[1-9][0-9]{0,19}', count)
                or int(count) > 18446744073709551615):
            raise ValueError('world health count mismatch')
    elif count is not None:
        raise ValueError('failed world health query must not claim a count')
    reason = ('writer-failed' if payload['writerFailed'] else
              'inflight-query-failed' if not payload['inflightQueryOk'] else
              'inflight-pending' if count != '0' else 'ready')
    if payload['reason'] != reason or payload['loginPermitted'] is not (reason == 'ready'):
        raise ValueError('contradictory world health snapshot')
    return payload


def world_login_ready(cfg):
    if compiled_capabilities(cfg)['CORE_REALM_BRIDGE_COMPILED'] == '0':
        return True
    url = 'http://127.0.0.1:7878/'
    body = (b'<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">'
            b'<SOAP-ENV:Body><ns1:executeCommand xmlns:ns1="urn:MaNGOS">'
            b'<command>realmbridge v1 health</command></ns1:executeCommand>'
            b'</SOAP-ENV:Body></SOAP-ENV:Envelope>')
    credentials = (cfg['SOAP_ADMIN_USERNAME'] + ':' + cfg['SOAP_ADMIN_PASSWORD']).encode('ascii')
    request = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'text/xml', 'Authorization': 'Basic ' + base64.b64encode(credentials).decode('ascii')})
    try:
        with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoSoapRedirect()).open(request, timeout=2) as response:
            if response.status != 200 or response.geturl() != url:
                return False
            return parse_world_health(response.read(65537))['loginPermitted']
    except (OSError, ValueError, TypeError, urllib.error.URLError):
        # No response body, authentication header or provider secret is logged.
        return False


def update_readiness(cfg):
    for key, port in [('login', 3724), ('world', 8085), ('soap', 7878)]:
        STATE[key] = listening(port)
    prepared = all(STATE[key] for key in ('database', 'data', 'login', 'world', 'soap'))
    STATE['ready'] = prepared and world_login_ready(cfg)
    STATE['phase'] = ('listeners-ready' if STATE['ready'] else
                      'world-login-blocked' if prepared else 'world-starting')


def game_options(env):
    # Game parsers only need their own runtime configuration. Never inherit
    # migration, web database, SOAP operator or unrelated deployment secrets.
    clean = {key: env[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH') if key in env}
    clean['HOME'] = '/home/mangos'
    clean['REALM_BRIDGE_TEST_ENABLE'] = compiled_capabilities(env)['REALM_BRIDGE_TEST_ENABLE']
    return dict(env=clean, user=10001, group=10001, extra_groups=[], start_new_session=True)


def game_commands(cfg, root):
    capabilities = compiled_capabilities(cfg)
    world = ['/opt/mangos/bin/mangosd', '-c', str(root / 'config/mangosd.conf')]
    if capabilities['CORE_AHBOT_COMPILED'] == '1':
        world += ['-a', str(root / 'config/ahbot.conf')]
    if capabilities['CORE_PLAYERBOTS_COMPILED'] == '1':
        world += ['-p', str(root / 'config/aiplayerbot.conf')]
    return [['/opt/mangos/bin/realmd', '-c', str(root / 'config/realmd.conf')], world]


def prepare_game_permissions(root):
    # Extractor outputs use umask 022 and remain read-only to the game. Only
    # configuration and log paths require targeted ownership/mode changes.
    os.chown(root, 0, 10001)
    root.chmod(0o750)
    directory = root / 'config'
    os.chown(directory, 0, 10001)
    directory.chmod(0o750)
    for path in directory.glob('*.conf'):
        os.chown(path, 0, 10001)
        path.chmod(0o640)
    os.chown(root / 'logs', 10001, 10001)
    (root / 'logs').chmod(0o750)


class Status(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/healthz', '/readyz', '/status'):
            self.send_error(404)
            return
        self.send_response(200 if self.path != '/readyz' or STATE['ready'] else 503)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(json.dumps(STATE).encode())

    def log_message(self, *args):
        pass


def serve_maintenance(env):
    """Status-only process: no volume/config access, SQL or child processes."""
    port = env.get('PORT', '8080')
    if not str(port).isdigit() or not 1 <= int(port) <= 65535:
        raise ValueError('invalid maintenance PORT')
    STATE.update(phase='maintenance', maintenance=True, database=False, data=False,
                 login=False, world=False, soap=False, ready=False)

    def stop(signum, frame):
        STOP.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server = ThreadingHTTPServer(('0.0.0.0', int(port)), Status)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        STOP.wait()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    maintenance = os.environ.get('REALM_MAINTENANCE', '0')
    if maintenance not in ('0', '1'):
        raise ValueError('REALM_MAINTENANCE must be 0 or 1')
    if maintenance == '1':
        # This branch must precede every SQL/config/data initialization path,
        # including the explicit initialize/extract command modes.
        serve_maintenance(os.environ)
        return
    os.umask(0o022)
    cfg = settings(os.environ)
    root = Path('/realm-data')
    root.mkdir(parents=True, exist_ok=True)
    (root / 'logs').mkdir(exist_ok=True)
    import fcntl
    lock = (root / '.core-lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def stop(signum, frame):
        STOP.set()
        STATE['ready'] = False
        stop_children(CHILDREN)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server = ThreadingHTTPServer(('0.0.0.0', int(cfg['PORT'])), Status)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    game_started = False
    try:
        mode = sys.argv[1] if len(sys.argv) > 1 else 'serve'
        if mode == 'extract':
            extract(cfg, root)
            return
        if mode not in ('serve', 'initialize'):
            raise ValueError('mode must be serve, initialize or extract')
        configure(cfg, root)
        bootstrap(cfg, root)
        if mode == 'initialize':
            return
        STATE['phase'] = 'awaiting-data'
        while not STOP.is_set() and not extraction_ready(root):
            # Operator stages all input files then atomically creates this trigger.
            if (root / 'client/.input-ready').is_file():
                extract(cfg, root)
                break
            STOP.wait(5)
        if STOP.is_set():
            return
        STATE['data'] = True
        STATE['phase'] = 'world-starting'
        prepare_game_permissions(root)
        game_started = True
        for command in game_commands(cfg, root):
            CHILDREN.append(subprocess.Popen(command, cwd='/opt/mangos/bin', **game_options(os.environ)))
        while not STOP.wait(2):
            if any(p.poll() is not None for p in CHILDREN):
                raise RuntimeError('core child exited; terminating sibling for clean restart')
            update_readiness(cfg)
    except Exception as error:
        if game_started:
            # Runtime failures must reach ON_FAILURE rather than leave a live
            # status process permanently holding a stopped realm offline.
            STATE['phase'] = 'world-failed'
            STATE['ready'] = False
            raise
        # Keep the private status/SSH surface alive for repair without repeatedly
        # executing a failing initialization or erasing partially created data.
        STATE['phase'] = 'initialization-failed'
        STATE['ready'] = False
        print('Core initialization stopped: ' + str(error), flush=True)
        stop_children(CHILDREN)
        STOP.wait()
    finally:
        STATE['ready'] = False
        stop_children(CHILDREN)
        server.shutdown()
        lock.close()


if __name__ == '__main__':
    main()
