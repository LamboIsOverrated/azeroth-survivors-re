import { Ledger, accountId, parseUnits, MAX_TEST_ALLOCATION } from './ledger.mjs';
import { issueChallenge, verifyChallenge, chainBalances } from './wallet.mjs';
import { SOL_CURRENCY, genesisFor } from './solana-network.mjs';

function configuration(env) {
  let url;
  try { url = new URL(env.PUBLIC_ORIGIN); } catch { throw new Error('PUBLIC_ORIGIN is required for economy wallet challenges'); }
  if (url.origin !== env.PUBLIC_ORIGIN || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin');
  const allocation = env.ECONOMY_TEST_ALLOCATION_UNITS ?? '0';
  if (parseUnits(allocation) > MAX_TEST_ALLOCATION) throw new Error('Test allocation exceeds safe bound');
  const cluster = env.ECONOMY_SOLANA_CLUSTER ?? 'devnet';
  genesisFor(cluster);
  let rpc = null;
  if (env.ECONOMY_SOLANA_RPC_URL) {
    const endpoint = new URL(env.ECONOMY_SOLANA_RPC_URL);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('Solana RPC must use HTTPS');
    rpc = endpoint.href;
  }
  return {origin: url.origin, allocation, cluster, rpc};
}

function publicConfig(config) {
  return {phase: 'TEST', nonredeemable: true, noCarryover: true, settlementEnabled: false, currency: SOL_CURRENCY, cluster: config.cluster, mint: null, mintValidated: false, chainDisplayConfigured: Boolean(config.rpc), testAllocationAvailable: config.allocation !== '0', maxTestAllocationUnits: MAX_TEST_ALLOCATION.toString(), gameUnitConversion: null};
}

function send(res, status, data) {
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff', vary: 'Cookie, Origin'});
  res.end(JSON.stringify(data));
  return true;
}

async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) { const error = new Error('Request too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('JSON object required');
  return body;
}

function onlyKeys(body, allowed) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new Error('Unexpected request field');
}

async function characterSnapshot(req, getCharacters) {
  const unavailable = reason => ({available:false,reason});
  if (!getCharacters) return unavailable('Authoritative character balance integration is not configured. The account TEST vault is separate from game money.');
  try {
    const result=await getCharacters(req);
    if (!Array.isArray(result?.characters) || result.characters.length>20 || result.snapshot!=='last-saved' || result.nonredeemable!==true) throw new Error('Invalid character snapshot');
    const characters=result.characters.map(row=>{
      const guid=typeof row.guid==='number' && Number.isSafeInteger(row.guid) ? String(row.guid) : row.guid;
      if (typeof guid!=='string' || !/^[1-9][0-9]{0,19}$/.test(guid) || typeof row.name!=='string' || row.name.length<1 || row.name.length>64 || typeof row.online!=='boolean' || parseUnits(row.moneyUnits)>2147483646n) throw new Error('Invalid character snapshot');
      return {guid,name:row.name,moneyUnits:row.moneyUnits,online:row.online};
    });
    if (new Set(characters.map(row=>row.guid)).size!==characters.length) throw new Error('Duplicate character snapshot');
    return {available:true,characters,snapshot:'last-saved',nonredeemable:true};
  } catch { return unavailable('Authoritative character balances are temporarily unavailable. No balance has been inferred from the account TEST vault.'); }
}

export function createEconomy({identity, getCharacters, dbPath = '/state/economy.sqlite', env = process.env, fetchImpl = globalThis.fetch, now = Date.now}) {
  if (typeof identity !== 'function') throw new Error('An authenticated realm identity provider is required');
  const config = configuration(env);
  const ledger = new Ledger(dbPath);
  const rates = new Map();
  function limited(id) {
    const time = now();
    for (const [key, bucket] of rates) if (bucket.until <= time) rates.delete(key);
    if (!rates.has(id)) {
      if (rates.size >= 10000) return true;
      rates.set(id, {count: 0, until: time + 60000});
    }
    return ++rates.get(id).count > 60;
  }
  const vault = id => ({units: ledger.balance(id), denomination: 'TEST account vault units', nonredeemable: true, linkedToCharacterMoney: false});
  const handler = async (req, res) => {
    if (!(req.url === '/api/economy' || req.url?.startsWith('/api/economy/'))) return false;
    let user;
    try { user = await identity(req); if (user) accountId(user.id); }
    catch { return send(res, 503, {error: 'Realm identity unavailable'}); }
    if (!user) return send(res, 401, {error: 'Sign into your realm account first'});
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin !== undefined && req.headers.origin !== config.origin)) return send(res, 403, {error: 'Origin rejected'});
    if (limited(user.id)) return send(res, 429, {error: 'Too many economy requests'});
    const path = req.url.split('?')[0].slice('/api/economy'.length);
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, {error: 'Method not allowed'});
    if (req.method === 'POST' && (req.headers.origin !== config.origin || req.headers['x-realm-economy'] !== '1' || !/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? ''))) return send(res, 403, {error: 'Same-origin JSON request required'});
    try {
      if (req.method === 'GET' && path === '/state') return send(res, 200, {config: publicConfig(config), vault: vault(user.id), wallet: {address: ledger.wallet(user.id)}, characterMoney: await characterSnapshot(req,getCharacters)});
      if (req.method === 'GET' && path === '/history') return send(res, 200, {entries: ledger.history(user.id), limit: 50});
      if (req.method === 'GET' && path === '/wallet/balances') {
        try { return send(res, 200, await chainBalances({wallet: ledger.wallet(user.id), cluster: config.cluster, rpc: config.rpc, fetchImpl})); }
        catch { return send(res, 503, {available: false, error: 'Chain balances are temporarily unavailable. No account funds were changed.'}); }
      }
      if (req.method === 'POST' && ['/deposit', '/withdraw', '/swap'].includes(path)) return send(res, 503, {error: path === '/swap' ? 'The realm uses native SOL. No custom-token exchange is required.' : 'SOL settlement is not active. Treasury backing, signer operations, reconciliation and funded gameplay integration are required.', settlementEnabled: false, currency: 'SOL'});
      if (req.method === 'POST' && path === '/test-allocation') {
        const body = await jsonBody(req); onlyKeys(body, user.isAdmin === true ? ['units'] : []);
        const units = user.isAdmin === true && body.units !== undefined ? body.units : config.allocation;
        if (units === '0') return send(res, 403, {error: 'Test allocation is not enabled'});
        ledger.allocate(user.id, units);
        return send(res, 200, {vault: vault(user.id)});
      }
      if (req.method === 'POST' && path === '/wallet/challenge') {
        const body = await jsonBody(req); onlyKeys(body, ['wallet']);
        return send(res, 200, issueChallenge(ledger,user.id,body.wallet,config.origin,now()));
      }
      if (req.method === 'POST' && path === '/wallet/verify') {
        const body = await jsonBody(req); onlyKeys(body, ['challengeId', 'signature']);
        return send(res, 200, {wallet: {address: verifyChallenge(ledger,user.id,body.challengeId,body.signature,config.origin,now())}});
      }
      return send(res, 404, {error: 'Unknown economy endpoint'});
    } catch (error) {
      return send(res, [409,413].includes(error.status) ? error.status : 400, {error: error.status === 409 ? 'Wallet is linked to another account' : 'Invalid economy request'});
    }
  };
  handler.close = () => ledger.close();
  handler.walletFor = id => ledger.wallet(id);
  return handler;
}
