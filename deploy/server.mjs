import { createServer, request as proxyRequest } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream';
import { VersionedTransaction } from '@solana/web3.js';
import { readConfig, validPublicKey, SOL_MINT } from './economy.mjs';

const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = (value, secret) => createHmac('sha256', secret).update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 16384) throw fail(413, 'Request too large.');
  }
  try { return JSON.parse(text); } catch { throw fail(400, 'Invalid JSON request.'); }
}

function messageOf(base64) {
  if (typeof base64 !== 'string' || base64.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw fail(400, 'Invalid transaction.');
  try { return VersionedTransaction.deserialize(Buffer.from(base64, 'base64')); }
  catch { throw fail(400, 'Invalid transaction.'); }
}

export function createGateway({ env = process.env, fetchImpl = fetch, gameUrl, now = Date.now,
  gameStatus = () => ({ state: 'waiting', message: 'Game data is not configured yet.' }) } = {}) {
  const config = readConfig(env);
  const accessCode = env.GAME_ACCESS_CODE?.length >= 12 ? env.GAME_ACCESS_CODE : '';
  const sessionSecret = accessCode || randomBytes(32).toString('hex');
  const orders = new Map();
  const limits = new Map();
  const rpcUrl = env.SOLANA_RPC_URL || `https://api.${config.cluster}.solana.com`;
  const jupiter = 'https://api.jup.ag/swap/v2';

  function limit(key, max) {
    const window = Math.floor(now() / 60000);
    const prior = limits.get(key);
    const entry = prior?.window === window ? prior : { window, count: 0 };
    entry.count++; limits.set(key, entry);
    if (limits.size > 10000) for (const [k, v] of limits) if (v.window !== window) limits.delete(k);
    if (entry.count > max) throw fail(429, 'Too many requests. Please wait a minute.');
  }

  function session(req) {
    if (!accessCode) return null;
    const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('preview='))?.slice(8);
    if (!cookie || cookie.length > 250) return null;
    const [id, expiry, signature] = cookie.split('.');
    return /^\d+$/.test(expiry || '') && Number(expiry) > now() && equal(signature, digest(`${id}.${expiry}`, sessionSecret)) ? id : null;
  }

  async function upstream(url, options = {}) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw fail(502, 'The network service is temporarily unavailable. Try again.'); }
    if (!response.ok) throw fail(502, 'The network could not complete this request. A trading route or funds may be unavailable.');
    try { return await response.json(); } catch { throw fail(502, 'The network returned an invalid response.'); }
  }

  async function rpc(method, params) {
    const value = await upstream(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (value.error || value.result === undefined) throw fail(502, 'Wallet balances are temporarily unavailable.');
    return value.result;
  }

  function proxy(req, res, path) {
    if (!gameUrl || gameStatus().state !== 'ready') return json(res, 503, { error: gameStatus().message });
    const dest = new URL(gameUrl);
    const localPath = new URL(path, 'http://gateway');
    dest.pathname = localPath.pathname;
    dest.search = localPath.search;
    const forwarded = proxyRequest(dest, { method: req.method, headers: { 'accept-encoding': req.headers['accept-encoding'] || 'identity' } }, upstreamRes => {
      const headers = { ...upstreamRes.headers, 'cache-control': 'private, no-cache' };
      delete headers['transfer-encoding']; delete headers.connection;
      res.writeHead(upstreamRes.statusCode, headers);
      pipeline(upstreamRes, res, () => {});
    });
    forwarded.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'The game is restarting. Please retry.' }); else res.destroy(); });
    req.on('aborted', () => forwarded.destroy());
    forwarded.setTimeout(30000, () => forwarded.destroy());
    forwarded.end();
  }

  return createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) throw fail(400, 'Invalid request path.');
      const url = new URL(req.url, 'http://gateway');
      const path = url.pathname;
      if (path === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok', game: gameStatus().state, swapsEnabled: config.swapsEnabled });
      if (req.method === 'POST') {
        // SameSite cookies are supplemented with origin checks for browser mutation requests.
        const expectedHost = req.headers.host;
        if (req.headers.origin && new URL(req.headers.origin).host !== expectedHost) throw fail(403, 'Cross-origin requests are not allowed.');
      }
      if (path === '/api/session' && req.method === 'POST') {
        limit('login-global', 120);
        limit(`login:${req.socket.remoteAddress}:${String(req.headers['x-forwarded-for'] || '').split(',').at(-1).trim()}`, 12);
        const input = await body(req);
        if (!accessCode || typeof input.code !== 'string' || !equal(digest(input.code, sessionSecret), digest(accessCode, sessionSecret))) throw fail(401, 'Incorrect preview code.');
        const expiry = now() + 86400000;
        const value = `${randomBytes(24).toString('hex')}.${expiry}`;
        const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader('set-cookie', `preview=${value}.${digest(value, sessionSecret)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Strict${secure}`);
        return json(res, 200, { ok: true });
      }
      const staticFiles = { '/': ['index.html', 'text/html'], '/wallet.bundle.js': ['wallet.bundle.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (staticFiles[path] && req.method === 'GET') {
        const [file, type] = staticFiles[path];
        const content = await readFile(resolve(publicRoot, file));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }); return res.end(content);
      }
      const sid = session(req);
      if (!sid) throw fail(401, 'Enter the preview code to continue.');
      if (path === '/api/session' && req.method === 'DELETE') {
        res.setHeader('set-cookie', 'preview=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
        return json(res, 200, { ok: true });
      }
      if (path === '/api/config' && req.method === 'GET') return json(res, 200, { ...config, game: gameStatus() });
      if (path === '/api/balance' && req.method === 'GET') {
        limit(`balance:${sid}`, 30);
        const wallet = url.searchParams.get('wallet');
        if (!validPublicKey(wallet)) throw fail(400, 'Invalid wallet address.');
        const sol = await rpc('getBalance', [wallet, { commitment: 'confirmed' }]);
        if (!Number.isSafeInteger(sol.value) || sol.value < 0) throw fail(502, 'SOL balance could not be represented accurately.');
        let token = null;
        if (config.tokenMint && config.tokenDecimals !== null) {
          const accounts = await rpc('getTokenAccountsByOwner', [wallet, { mint: config.tokenMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
          let total = 0n;
          for (const entry of accounts.value) {
            const amount = entry.account.data.parsed.info.tokenAmount;
            if (amount.decimals !== config.tokenDecimals) throw fail(502, 'Token decimals do not match the launch configuration.');
            total += BigInt(amount.amount);
          }
          token = total.toString();
        }
        return json(res, 200, { sol: String(sol.value), token });
      }
      if (path.startsWith('/api/swap/')) {
        if (req.method !== 'POST') throw fail(405, 'Use POST for swap requests.');
        if (!config.swapsEnabled) throw fail(503, 'Exchange opens after the game token launches.');
        limit(`swaps:${sid}`, 20);
        const input = await body(req);
        const headers = { 'content-type': 'application/json', ...(env.JUPITER_API_KEY ? { 'x-api-key': env.JUPITER_API_KEY } : {}) };
        for (const [id, order] of orders) if (order.expires <= now()) orders.delete(id);
        if (path === '/api/swap/order') {
          if (input.inputMint !== undefined || input.outputMint !== undefined || !validPublicKey(input.wallet) ||
              !['buy', 'sell'].includes(input.direction) || typeof input.amount !== 'string' || !/^[1-9]\d{0,19}$/.test(input.amount) ||
              BigInt(input.amount) > 18446744073709551615n) throw fail(400, 'Invalid game-token swap request.');
          if (orders.size > 1000) throw fail(429, 'The exchange is busy. Try again shortly.');
          const inputMint = input.direction === 'buy' ? SOL_MINT : config.tokenMint;
          const outputMint = input.direction === 'buy' ? config.tokenMint : SOL_MINT;
          const params = new URLSearchParams({ inputMint, outputMint, amount: input.amount, taker: input.wallet, maxSupportedTransactionVersion: '0' });
          const result = await upstream(`${jupiter}/order?${params}`, { headers });
          if (!result.transaction || !result.requestId || !/^\d+$/.test(result.outAmount || '')) throw fail(502, 'No executable quote is available. Check liquidity and wallet funds.');
          const tx = messageOf(result.transaction);
          if (tx.message.staticAccountKeys[0].toBase58() !== input.wallet) throw fail(502, 'The quote did not match your wallet.');
          const expires = now() + 60000;
          orders.set(result.requestId, { sid, expires, message: Buffer.from(tx.message.serialize()) });
          return json(res, 200, { ...result, inputMint, outputMint, expires });
        }
        if (path === '/api/swap/execute') {
          const order = orders.get(input.requestId);
          if (!order || order.sid !== sid || order.expires <= now() || order.pending) throw fail(400, 'This quote has expired or was already submitted. Request a fresh quote.');
          const tx = messageOf(input.signedTransaction);
          if (!order.message.equals(Buffer.from(tx.message.serialize()))) throw fail(400, 'The signed transaction differs from the reviewed quote.');
          if (tx.signatures.every(signature => signature.every(byte => byte === 0))) throw fail(400, 'The wallet has not signed this transaction.');
          // Reserve before awaiting upstream; parallel clicks cannot execute an order twice.
          order.pending = true;
          orders.delete(input.requestId);
          const result = await upstream(`${jupiter}/execute`, { method: 'POST', headers,
            body: JSON.stringify({ requestId: input.requestId, signedTransaction: input.signedTransaction }) });
          return json(res, result.status === 'Success' && result.code === 0 ? 200 : 502, result);
        }
        throw fail(404, 'Unknown exchange endpoint.');
      }
      if (path.startsWith('/api/') || path.startsWith('/ws')) throw fail(404, 'Not found.');
      if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Method not allowed.');
      if (path === '/game/') { res.writeHead(302, { location: '/game' }); return res.end(); }
      return proxy(req, res, path === '/game' ? '/index.html' : req.url);
    } catch (error) {
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'The service could not complete this request.' });
      else res.destroy();
    }
  });
}
