"""Private CMaNGOS supervisor. Listener readiness is not gameplay verification."""
import hashlib
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCHEMAS = ('classicrealmd', 'classiccharacters', 'classicmangos', 'classiclogs')
CORE = 'de8f72993b9e1faa1bf92dd5505f3daec5cea3ce'
STATE = dict(phase='starting', maintenance=False, database=False, data=False,
             login=False, world=False, soap=False, ready=False)
STOP = threading.Event()
CHILDREN = []


def settings(env):
    cfg = dict(env)
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
    for name, updates in values.items():
        template = templates / (name + '.conf.dist')
        write_private(root / 'config' / (name + '.conf'), replace_config(template.read_text(), updates))
    (root / 'logs').mkdir(exist_ok=True)


def data_ready(data):
    return all(any(p.is_file() and p.stat().st_size > 0 for p in (data / folder).glob(pattern))
               for folder, pattern in [('dbc', '*.dbc'), ('maps', '*.map'), ('vmaps', '*.vmtree'), ('mmaps', '*.mmap')])


def extraction_ready(root):
    try:
        marker = json.loads((root / 'extraction/complete.json').read_text())
        return marker.get('core') == CORE and data_ready(root / 'data')
    except (OSError, ValueError):
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
 VALUES (1,'Vanilla TEST PvP','{cfg['REALM_DOMAIN']}',8085,1,0,8,0,0,'5875');
UPDATE classicrealmd.realmlist SET name='Vanilla TEST PvP',address='{cfg['REALM_DOMAIN']}',
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


def bootstrap(cfg, root):
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
    files = sorted(p for p in (client / 'Data').rglob('*') if p.is_file() and p.suffix.lower() == '.mpq')
    if not files:
        raise RuntimeError('operator input missing: /realm-data/client/Data/*.MPQ')
    data.mkdir(parents=True, exist_ok=True)
    manifest = json.dumps([(str(p.relative_to(client)), p.stat().st_size, p.stat().st_mtime_ns) for p in files])
    fingerprint = hashlib.sha256((CORE + manifest).encode()).hexdigest()
    stages = root / 'extraction'
    stages.mkdir(exist_ok=True)
    tools = Path('/opt/mangos/bin/tools')
    plan = [('dbc-maps', [str(tools / 'ad'), '-i', str(client), '-o', str(data)]),
            ('vmap-extract', [str(tools / 'vmap_extractor'), '-d', str(client / 'Data'), '-o', str(data)]),
            ('vmap-assemble', [str(tools / 'vmap_assembler'), str(data / 'Buildings'), str(data / 'vmaps')]),
            ('mmaps', [str(tools / 'MoveMapGen'), '--silent', '--configInputPath', str(tools / 'config.json'),
                       '--offMeshInput', str(tools / 'offmesh.txt'), '--workdir', str(data) + '/',
                       '--threads', cfg['EXTRACT_THREADS'], '--buildGameObjects'])]
    shutil.copyfile('/opt/src/mangos-classic/contrib/extractor_scripts/config.json', tools / 'config.json')
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
    write_private(stages / 'complete.json', json.dumps({'core': CORE, 'input': fingerprint}))
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


def game_options(env):
    # Game parsers only need their own runtime configuration. Never inherit
    # migration, web database, SOAP operator or unrelated deployment secrets.
    clean = {key: env[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH') if key in env}
    clean['HOME'] = '/home/mangos'
    return dict(env=clean, user=10001, group=10001, extra_groups=[], start_new_session=True)


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
        for command in [['/opt/mangos/bin/realmd', '-c', str(root / 'config/realmd.conf')],
                        ['/opt/mangos/bin/mangosd', '-c', str(root / 'config/mangosd.conf'),
                         '-a', str(root / 'config/ahbot.conf'), '-p', str(root / 'config/aiplayerbot.conf')]]:
            CHILDREN.append(subprocess.Popen(command, cwd='/opt/mangos/bin', **game_options(os.environ)))
        while not STOP.wait(2):
            if any(p.poll() is not None for p in CHILDREN):
                raise RuntimeError('core child exited; terminating sibling for clean restart')
            for key, port in [('login', 3724), ('world', 8085), ('soap', 7878)]:
                STATE[key] = listening(port)
            STATE['ready'] = all(STATE[key] for key in ('database', 'data', 'login', 'world', 'soap'))
            STATE['phase'] = 'listeners-ready' if STATE['ready'] else 'world-starting'
    except Exception as error:
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


if __name__ == '__main__':
    main()
