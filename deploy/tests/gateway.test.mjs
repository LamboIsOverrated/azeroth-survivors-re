import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

const module = await import('../server.mjs').catch(() => ({}));
const units = await import('../economy.mjs').catch(() => ({}));
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const wallet = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58();
function transaction(lamports = 1) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports })],
  }).compileToV0Message()).serialize();
}

test('integer token amounts preserve precision and reject rounded or ambiguous input', () => {
  assert.equal(typeof units.parseUnits, 'function');
  assert.equal(units.parseUnits('9007199.254740993', 9), '9007199254740993');
  assert.equal(units.formatUnits('9007199254740993', 9), '9007199.254740993');
  for (const amount of ['-1', '1e3', '0', '1.0000000001', 'NaN', '', ' 1', '01']) {
    assert.throws(() => units.parseUnits(amount, 9));
  }
});

async function fixture(t, { launched = false, env = {}, upstream, gameUrl, gameStatus, clock } = {}) {
  assert.equal(typeof module.createGateway, 'function');
  const server = module.createGateway({ env: { GAME_ACCESS_CODE: 'test-preview-access-code', GAME_TOKEN_MINT: mint,
    GAME_TOKEN_DECIMALS: '6', TOKEN_LAUNCHED: String(launched), SWAPS_ENABLED: String(launched), ...env },
    fetchImpl: upstream || (() => { throw new Error('unexpected upstream request'); }), gameUrl, gameStatus, now: clock });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'test-preview-access-code' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (path, body, headers = {}) => fetch(`${base}${path}`, { method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json', origin: base, ...headers },
    body: body ? JSON.stringify(body) : undefined });
  return { base, request, cookie };
}

test('preview protects data, game bundle, wallet APIs, and missing credentials fail closed', async (t) => {
  const { base, request } = await fixture(t);
  for (const path of ['/data/__index', '/wenilla_bg.wasm', '/game', '/api/balance?wallet=abc']) {
    assert.equal((await fetch(base + path)).status, 401, path);
  }
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await request('/ws/8085')).status, 404);
  const bad = await fetch(base + '/api/session', { method: 'POST', body: JSON.stringify({ code: 'wrong' }) });
  assert.equal(bad.status, 401);
  const config = await (await request('/api/config')).json();
  assert.equal(config.swapsEnabled, false);
  assert.equal(JSON.stringify(config).includes('test-preview-access-code'), false);
  const server = module.createGateway({ env: {} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/data/__index`)).status, 401);
});

test('prelaunch or missing mint cannot request or execute swaps', async (t) => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/swap/order', {})).status, 503);
  assert.equal((await request('/api/swap/execute', {})).status, 503);
  const missing = await fixture(t, { launched: true, env: { GAME_TOKEN_MINT: '' } });
  assert.equal((await missing.request('/api/config')).status, 200);
  assert.equal((await missing.request('/api/swap/order', {})).status, 503);
});

test('proxy refuses protocol-relative request paths instead of connecting to another host', async (t) => {
  const { base, cookie } = await fixture(t, { gameUrl: 'http://127.0.0.1:1', gameStatus: () => ({ state: 'ready' }) });
  const response = await fetch(`${base}//127.0.0.1:1/private`, { headers: { cookie } });
  assert.equal(response.status, 400);
  const absoluteStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(base, { path: 'http://127.0.0.1:1/private', headers: { cookie } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.on('error', reject); req.end();
  });
  assert.equal(absoluteStatus, 400);
});

test('swaps reject arbitrary token pairs, malformed amounts and cross-origin posts before calling Jupiter', async (t) => {
  const { request } = await fixture(t, { launched: true });
  const valid = { wallet: wallet.publicKey.toBase58(), direction: 'buy', amount: '1000000' };
  for (const changes of [{ direction: 'other' }, { amount: '-1' }, { amount: '1e9' }, { amount: '18446744073709551616' },
    { inputMint: mint }, { wallet: 'invalid' }]) {
    assert.equal((await request('/api/swap/order', { ...valid, ...changes })).status, 400);
  }
  assert.equal((await request('/api/swap/order', valid, { origin: 'https://another-site.example' })).status, 403);
});

test('issued orders bind direction, wallet, unchanged transaction message and session; replay is rejected', async (t) => {
  const unsigned = Buffer.from(transaction()).toString('base64');
  let calls = 0;
  const upstream = async (url, options = {}) => {
    calls++;
    if (String(url).includes('/order?')) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('inputMint'), 'So11111111111111111111111111111111111111112');
      assert.equal(params.get('outputMint'), mint);
      assert.equal(params.get('taker'), wallet.publicKey.toBase58());
      assert.equal(params.get('amount'), '9007199254740993');
      return Response.json({ requestId: 'issued-order', transaction: unsigned, inAmount: '9007199254740993', outAmount: '1234567',
        inputMint: params.get('inputMint'), outputMint: mint, otherAmountThreshold: '1200000', priceImpactPct: '0.01' });
    }
    assert.equal(JSON.parse(options.body).requestId, 'issued-order');
    return Response.json({ status: 'Success', signature: 'confirmed-signature', code: 0 });
  };
  const { request } = await fixture(t, { launched: true, upstream });
  const order = await request('/api/swap/order', { wallet: wallet.publicKey.toBase58(), direction: 'buy', amount: '9007199254740993' });
  assert.equal(order.status, 200);
  const data = await order.json();
  const another = await fixture(t, { launched: true, upstream });
  assert.equal((await another.request('/api/swap/execute', { requestId: data.requestId, signedTransaction: unsigned })).status, 400);
  assert.equal((await request('/api/swap/execute', { requestId: data.requestId,
    signedTransaction: Buffer.from(transaction(9)).toString('base64') })).status, 400);
  const signed = VersionedTransaction.deserialize(Buffer.from(unsigned, 'base64'));
  signed.sign([wallet]);
  const body = { requestId: data.requestId, signedTransaction: Buffer.from(signed.serialize()).toString('base64') };
  const execute = await request('/api/swap/execute', body);
  assert.equal(execute.status, 200);
  assert.equal((await execute.json()).status, 'Success');
  assert.equal((await request('/api/swap/execute', body)).status, 400);
  assert.equal(calls, 2);
});

test('expired orders and upstream errors cannot become a successful exchange', async (t) => {
  let now = 1000;
  const unsigned = Buffer.from(transaction()).toString('base64');
  const expired = await fixture(t, { launched: true, clock: () => now, upstream: async () => Response.json({
    requestId: 'expires', transaction: unsigned, inAmount: '1', outAmount: '1' }) });
  assert.equal((await expired.request('/api/swap/order', { wallet: wallet.publicKey.toBase58(), direction: 'buy', amount: '1' })).status, 200);
  now += 180000;
  assert.equal((await expired.request('/api/swap/execute', { requestId: 'expires', signedTransaction: unsigned })).status, 400);
  const failure = await fixture(t, { launched: true, upstream: async () => Response.json({ error: 'No liquidity' }, { status: 400 }) });
  assert.equal((await failure.request('/api/swap/order', { wallet: wallet.publicKey.toBase58(), direction: 'buy', amount: '1' })).status, 502);
});
