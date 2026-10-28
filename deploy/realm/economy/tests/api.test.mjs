import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { createEconomy } from '../api.mjs';
import { Ledger } from '../ledger.mjs';
import { issueChallenge, verifyChallenge, chainBalances } from '../wallet.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://realm.example';
const keys = () => {
  const pair = generateKeyPairSync('ed25519');
  return {...pair, wallet: new PublicKey(pair.publicKey.export({format: 'der', type: 'spki'}).subarray(-32)).toBase58()};
};
async function fixture(t, env = {}, extras = {}) {
  const economy = createEconomy({identity: async req => req.headers['x-account'] ? {id: Number(req.headers['x-account']), username: 'player', isAdmin: req.headers['x-admin'] === 'yes'} : null, dbPath: ':memory:', env: {PUBLIC_ORIGIN: origin, ...env}, ...extras});
  const server = createServer((req,res) => economy(req,res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); economy.close(); });
  return {economy, async request(path, {method = 'GET', account = '1', body, headers = {}} = {}) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/economy${path}`, {method, headers: {...(account ? {'x-account': account} : {}), ...(method === 'POST' ? {origin, 'content-type': 'application/json', 'x-realm-economy': '1'} : {}), ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: res.status, headers: res.headers, body: await res.json()};
  }};
}

test('every account endpoint authenticates and responses prevent caching', async t => {
  const {request} = await fixture(t);
  for (const path of ['/state', '/history', '/wallet/balances']) {
    const response = await request(path, {account: null});
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
  }
  const state = await request('/state');
  assert.equal(state.body.vault.units, '0');
  assert.equal(state.body.characterMoney.available, false);
  assert.equal(state.body.config.settlementEnabled, false);
  assert.equal(state.body.config.noCarryover, true);
});

test('test allocation is bounded, self-only, and cannot repeat on reconnect', async t => {
  const {request} = await fixture(t, {ECONOMY_TEST_ALLOCATION_UNITS: '100'});
  assert.equal((await request('/test-allocation', {method: 'POST', body: {accountId: 2, units: '999'}})).status, 400);
  const allocation = await request('/test-allocation', {method: 'POST', body: {}});
  assert.equal(allocation.body.vault.units, '100');
  assert.equal((await request('/test-allocation', {method: 'POST', body: {}})).body.vault.units, '100');
  assert.equal((await request('/state', {account: '2'})).body.vault.units, '0');
  assert.equal((await request('/history', {account: '2'})).body.entries.length, 0);
  assert.equal((await request('/history')).body.entries.length, 1);
});

test('mutations require exact origin, custom CSRF header, and JSON', async t => {
  const {request} = await fixture(t, {ECONOMY_TEST_ALLOCATION_UNITS: '100'});
  for (const headers of [{origin: 'https://evil.example'}, {origin: 'null'}, {origin: ''}, {'x-realm-economy': ''}, {'content-type': 'text/plain'}, {'sec-fetch-site': 'cross-site'}]) {
    assert.equal((await request('/test-allocation', {method: 'POST', body: {}, headers})).status, 403);
  }
  assert.equal((await request('/state')).body.vault.units, '0');
});

test('client kill rewards and all settlement stay closed even with launch-like env', async t => {
  const {request} = await fixture(t, {ECONOMY_MAINNET_ENABLED: 'true', ECONOMY_TOKEN_MINT: '11111111111111111111111111111111'});
  for (const path of ['/deposit', '/withdraw', '/swap']) assert.equal((await request(path, {method: 'POST', body: {units: '999'}})).status, 503);
  assert.equal((await request('/reward', {method: 'POST', body: {kills: 999}})).status, 404);
  assert.equal((await request('/test-allocation', {method: 'POST', body: {}})).status, 403);
  assert.equal((await request('/state')).body.vault.units, '0');
});

test('signed wallet binding requires actual ed25519 proof and rejects cross-account/replay/tampering', async t => {
  const {request} = await fixture(t);
  const pair = keys(), other = keys();
  const challenge = (await request('/wallet/challenge', {method: 'POST', body: {wallet: pair.wallet}})).body;
  assert.match(challenge.message, /https:\/\/realm\.example/);
  const signature = sign(null, Buffer.from(challenge.message), pair.privateKey).toString('base64');
  assert.equal((await request('/wallet/verify', {method: 'POST', account: '2', body: {challengeId: challenge.challengeId, signature}})).status, 400);
  const badSignature = sign(null, Buffer.from(challenge.message + '!'), pair.privateKey).toString('base64');
  assert.equal((await request('/wallet/verify', {method: 'POST', body: {challengeId: challenge.challengeId, signature: badSignature}})).status, 400);
  assert.equal((await request('/wallet/verify', {method: 'POST', body: {challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), other.privateKey).toString('base64')}})).status, 400);
  assert.equal((await request('/wallet/verify', {method: 'POST', body: {challengeId: challenge.challengeId, signature}})).status, 200);
  assert.equal((await request('/wallet/verify', {method: 'POST', body: {challengeId: challenge.challengeId, signature}})).status, 400);
  assert.equal((await request('/state')).body.wallet.address, pair.wallet);
  assert.equal((await request('/state', {account: '2'})).body.wallet.address, null);
  const stolen = (await request('/wallet/challenge', {method: 'POST', account: '2', body: {wallet: pair.wallet}})).body;
  assert.equal((await request('/wallet/verify', {method: 'POST', account: '2', body: {challengeId: stolen.challengeId, signature: sign(null, Buffer.from(stolen.message), pair.privateKey).toString('base64')}})).status, 409);
});

test('expired challenges cannot bind wallets', async t => {
  let now = Date.now();
  const {request} = await fixture(t, {}, {now: () => now});
  const pair = keys();
  const challenge = (await request('/wallet/challenge', {method: 'POST', body: {wallet: pair.wallet}})).body;
  now += 300_001;
  assert.equal((await request('/wallet/verify', {method: 'POST', body: {challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message), pair.privateKey).toString('base64')}})).status, 400);
});

test('wallet proof survives restart but never a different domain or consumed replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'realm-wallet-'));
  const path = join(dir, 'economy.sqlite');
  const pair = keys(), now = Date.now();
  let ledger = new Ledger(path);
  try {
    const challenge = issueChallenge(ledger,1,pair.wallet,origin,now);
    const signature = sign(null,Buffer.from(challenge.message),pair.privateKey).toString('base64');
    ledger.close(); ledger = new Ledger(path);
    assert.throws(() => verifyChallenge(ledger,1,challenge.challengeId,signature,'https://other.example',now));
    assert.equal(verifyChallenge(ledger,1,challenge.challengeId,signature,origin,now), pair.wallet);
    ledger.close(); ledger = new Ledger(path);
    assert.equal(ledger.wallet(1),pair.wallet);
    assert.throws(() => verifyChallenge(ledger,1,challenge.challengeId,signature,origin,now));
  } finally { ledger.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('administrator allocation stays bounded and one time without giving players amount control', async t => {
  const {request} = await fixture(t);
  const allocation = body => request('/test-allocation', {method:'POST', body, headers:{'x-admin':'yes'}});
  for (const units of ['0','1000000001',1,'1e2','1.5','9223372036854775808']) assert.notEqual((await allocation({units})).status,200);
  assert.equal((await allocation({units:'120'})).body.vault.units,'120');
  assert.equal((await allocation({units:'240'})).body.vault.units,'120');
  assert.equal((await request('/test-allocation',{method:'POST',account:'2',body:{units:'120'}})).status,400);
});

test('configured token address may be off curve and never enables settlement', async t => {
  const [mint] = PublicKey.findProgramAddressSync([Buffer.from('mint')],new PublicKey('11111111111111111111111111111111'));
  const {request} = await fixture(t,{ECONOMY_TOKEN_MINT:mint.toBase58()});
  const {body} = await request('/state');
  assert.equal(body.config.mint,mint.toBase58());
  assert.equal(body.config.mintValidated,false);
  assert.equal(body.config.settlementEnabled,false);
});

test('chain balance display preserves integer atoms and rejects imprecise RPC values', async () => {
  const wallet = keys().wallet, mint = keys().wallet;
  const fetchImpl = async (_url,options) => {
    const request = JSON.parse(options.body);
    if(request.method === 'getBalance') return {ok:true,json:async()=>({result:{context:{slot:100},value:1234567890}})};
    return {ok:true,json:async()=>({result:{context:{slot:100},value:[{account:{data:{parsed:{info:{mint,owner:wallet,tokenAmount:{amount:'9007199254740993',decimals:9}}}}}},{account:{data:{parsed:{info:{mint,owner:wallet,tokenAmount:{amount:'7',decimals:9}}}}}}]}})};
  };
  const result = await chainBalances({wallet,mint,rpc:'https://rpc.example',fetchImpl});
  assert.equal(result.solLamports,'1234567890');
  assert.equal(result.token.atoms,'9007199254741000');
  assert.equal(result.displayOnly,true);
  await assert.rejects(()=>chainBalances({wallet,mint,rpc:'https://rpc.example',fetchImpl:async()=>({ok:true,json:async()=>({result:{value:9007199254740992}})})}));
});

test('character money uses only trusted account adapter and exact last-saved snapshots', async t => {
  const {request} = await fixture(t, {}, {getCharacters:async req=>({characters:req.headers['x-account']==='1' ? [{guid:7,name:'Thrall',moneyUnits:'2147483646',online:true}] : [],snapshot:'last-saved',nonredeemable:true})});
  const response=await request('/state?accountId=2&guid=999&moneyUnits=999999999');
  assert.deepEqual(response.body.characterMoney,{available:true,characters:[{guid:'7',name:'Thrall',moneyUnits:'2147483646',online:true}],snapshot:'last-saved',nonredeemable:true});
  assert.equal(response.body.vault.units,'0');
  assert.equal((await request('/state',{account:'2'})).body.characterMoney.characters.length,0);
});

test('invalid or failed authoritative snapshots never become made-up character money', async t => {
  for (const value of [{characters:[{guid:1,name:'Player',moneyUnits:1,online:false}],snapshot:'last-saved',nonredeemable:true},{characters:[{guid:1,name:'Player',moneyUnits:'2147483647',online:false}],snapshot:'last-saved',nonredeemable:true},{characters:[],snapshot:'live',nonredeemable:true},null]) {
    const {request}=await fixture(t,{}, {getCharacters:async()=>value});
    assert.equal((await request('/state')).body.characterMoney.available,false);
  }
  const {request}=await fixture(t,{}, {getCharacters:async()=>{throw new Error('private database detail');}});
  const {body}=await request('/state');
  assert.equal(body.characterMoney.available,false);
  assert.doesNotMatch(JSON.stringify(body),/private database detail/);
});
