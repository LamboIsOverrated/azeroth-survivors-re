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

test('native SOL replaces the launch token without converting existing TEST balances', async t => {
  const {request} = await fixture(t,{ECONOMY_TOKEN_MINT:'retired-invalid-mint',GAME_TOKEN_MINT:'retired-token',TOKEN_LAUNCHED:'true',SWAPS_ENABLED:'true',ECONOMY_TEST_ALLOCATION_UNITS:'100'});
  const {body} = await request('/state');
  assert.deepEqual(body.config.currency,{symbol:'SOL',name:'Solana',assetKind:'native-sol',decimals:9,requiresMint:false});
  assert.equal(body.config.cluster,'devnet');
  assert.equal(body.config.mint,null);
  assert.equal(body.config.settlementEnabled,false);
  assert.equal(body.config.gameUnitConversion,null);
  assert.equal(body.config.nonredeemable,true);
  const allocation=await request('/test-allocation',{method:'POST',body:{}});
  assert.equal(allocation.body.vault.units,'100');
  assert.equal(allocation.body.vault.nonredeemable,true);
  assert.equal(allocation.body.vault.linkedToCharacterMoney,false);
});

test('native SOL display pins the chain before exact finalized lamport reads and never queries tokens', async () => {
  const wallet = keys().wallet, calls=[];
  const fetchImpl = async (_url,options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const result=request.method==='getGenesisHash' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' : {context:{slot:100},value:1234567890};
    return {ok:true,json:async()=>({jsonrpc:'2.0',id:1,result})};
  };
  const result = await chainBalances({wallet,cluster:'devnet',rpc:'https://rpc.example',fetchImpl});
  assert.equal(result.solLamports,'1234567890');
  assert.equal(result.cluster,'devnet');
  assert.equal(result.genesisVerified,true);
  assert.equal(result.token,undefined);
  assert.equal(result.displayOnly,true);
  assert.deepEqual(calls.map(call=>call.method),['getGenesisHash','getBalance']);
  assert.deepEqual(calls[1].params,[wallet,{commitment:'finalized'}]);
});

test('SOL reads refuse wrong networks, invalid contexts and rounded balances', async () => {
  const wallet=keys().wallet;
  for(const [genesis,balance] of [
    ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2dN',{context:{slot:100},value:123}],
    ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',{context:{slot:100},value:9007199254740992}],
    ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',{context:{slot:-1},value:123}],
    ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',{context:{slot:100},value:-1}],
  ]) {
    const calls=[];
    await assert.rejects(()=>chainBalances({wallet,cluster:'devnet',rpc:'https://rpc.example',fetchImpl:async(_url,options)=>{
      const request=JSON.parse(options.body);calls.push(request.method);
      return {ok:true,json:async()=>({jsonrpc:'2.0',id:1,result:request.method==='getGenesisHash'?genesis:balance})};
    }}));
    if(genesis.startsWith('5ey'))assert.deepEqual(calls,['getGenesisHash']);
  }
});

test('native SOL public config never exposes RPC credentials and rejects unsupported clusters', async t => {
  const {request}=await fixture(t,{ECONOMY_SOLANA_CLUSTER:'mainnet-beta',ECONOMY_SOLANA_RPC_URL:'https://rpc.example/?api-key=private-rpc-secret'});
  const response=await request('/state');
  assert.equal(response.body.config.cluster,'mainnet-beta');
  assert.doesNotMatch(JSON.stringify(response.body),/private-rpc-secret|rpc.example/);
  assert.throws(()=>createEconomy({identity:async()=>({id:1}),dbPath:':memory:',env:{PUBLIC_ORIGIN:origin,ECONOMY_SOLANA_CLUSTER:'attacker-cluster'}}));
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
