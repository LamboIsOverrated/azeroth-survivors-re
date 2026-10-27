import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createGateway } from './server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.env.WOW_DATA_DIR || '/game-data';
const data = resolve(dataRoot, 'Data');
const binary = process.env.GAME_HOST_BINARY || resolve(root, 'bin/wenilla-host');
let state = { state: 'waiting', message: 'The game is waiting for its data files.' };
let child;
let stopped = false;
const gameUrl = 'http://127.0.0.1:8091';
const gateway = createGateway({ gameUrl, gameStatus: () => state });
gateway.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log(`Gateway listening on ${gateway.address().port}`));

function startHost() {
  if (stopped) return;
  state = { state: 'loading', message: 'The game is starting. This page refreshes its status automatically.' };
  child = spawn(binary, ['--bind', '127.0.0.1:8091', '--www', resolve(root, 'web/dist'), '--data', data], { stdio: 'inherit' });
  const interval = setInterval(async () => {
    try {
      const response = await fetch(`${gameUrl}/index.html`, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok) { state = { state: 'ready', message: 'The battleground is ready.' }; clearInterval(interval); }
    } catch { /* The host opens its patch chain before listening. */ }
  }, 1000);
  child.on('error', error => { console.error('Game host could not start:', error.message); clearInterval(interval); state = { state: 'error', message: 'The game could not start. Please try again later.' }; });
  child.on('exit', code => { clearInterval(interval); if (!stopped) { console.error(`Game host exited: ${code}`); state = { state: 'error', message: 'The game stopped. Please try again later.' }; } });
}

if (existsSync(resolve(data, 'terrain.MPQ')) && existsSync(resolve(data, 'patch.MPQ'))) startHost();
else if (process.env.DOWNLOAD_GAME_DATA === 'true') {
  state = { state: 'downloading', message: 'Preparing the game data for its first run. This can take several minutes; you can leave this page open.' };
  child = spawn('bash', [resolve(root, 'scripts/fetch-data.sh')], { env: { ...process.env, WOW_DATA_DIR: dataRoot }, stdio: 'inherit' });
  child.on('error', error => { console.error('Game data initialization failed:', error.message); state = { state: 'error', message: 'The game data could not be prepared. Please try again later.' }; });
  child.on('exit', code => { if (code === 0) startHost(); else if (!stopped) state = { state: 'error', message: 'The game data download did not finish. Please try again later.' }; });
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; child?.kill('SIGTERM'); gateway.close(); setTimeout(() => process.exit(0), 5000).unref(); });
