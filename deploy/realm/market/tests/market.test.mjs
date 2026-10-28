import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createMarket } from '../index.mjs';

// Fixed, in-memory offline signing fixtures. No key files or live chain requests.
const signer = Keypair.fromSeed(Uint8Array.from({length:32}, (_,i) => i+1));
const other = Keypair.fromSeed(Uint8Array.from({length:32}, (_,i) => 100+i));
const wallet = signer.publicKey.toBase58();
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2dN';
const ORIGIN = 'https://realm.example';
function transaction(payer=signer, lamports=1) {
  return new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:PublicKey.default.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:other.publicKey,lamports})]}).compileToV0Message());
}
function signed(base64) { const tx=VersionedTransaction.deserialize(Buffer.from(base64,'base64')); tx.sign([signer]); return Buffer.from(tx.serialize()).toString('base64'); }
function mintAccount({owner=TOKEN,size=82,decimals=6,initialized=1,executable=false}={}) { const data=Buffer.alloc(size);data[44]=decimals;data[45]=initialized;return {owner,executable,data:[data.toString('base64'),'base64']}; }
async function fixture(t, {env={},account=mintAccount(),genesis=GENESIS,quote={},execute,fetchOverride}={}) {
  let clock=1_800_000_000_000; let linked=wallet; let executes=0; const requests=[];
  const fetchImpl=async(url,options={})=>{
    requests.push({url:String(url),options});
    if (fetchOverride) { const override=await fetchOverride(url,options);if(override) return override; }
    if (String(url).startsWith('https://rpc.example/')) {
      const {method,params}=JSON.parse(options.body);
      let result;
      if(method==='getGenesisHash') result=genesis;
      else if(method==='getAccountInfo') {assert.equal(params[0],mint);result={value:account};}
      else if(method==='getSignatureStatuses') result={value:[null]};
      else if(method==='getBlockHeight') result=100;
      else throw new Error(`Unexpected RPC ${method}`);
      return Response.json({jsonrpc:'2.0',id:1,result});
    }
    if(String(url).startsWith('https://api.jup.ag/swap/v2/order?')) {
      const params=new URL(url).searchParams;
      assert.equal(params.get('taker'),wallet);assert.equal(params.get('maxSupportedTransactionVersion'),'0');
      return Response.json({inputMint:params.get('inputMint'),outputMint:params.get('outputMint'),inAmount:params.get('amount'),outAmount:'2000000',transaction:Buffer.from(transaction().serialize()).toString('base64'),requestId:`request-${requests.length}`,router:'metis',feeBps:5,feeMint:SOL,lastValidBlockHeight:200,...quote});
    }
    if(String(url)==='https://api.jup.ag/swap/v2/execute') {executes++;return execute?execute(url,options):Response.json({status:'Success',code:0});}
    throw new Error(`Unexpected URL ${url}`);
  };
  const handler=createMarket({env:{PUBLIC_ORIGIN:ORIGIN,ECONOMY_TOKEN_MINT:mint,ECONOMY_SOLANA_RPC_URL:'https://rpc.example/',TOKEN_LAUNCHED:'true',SWAPS_ENABLED:'true',...env},identity:async req=>req.headers.cookie?.includes('noauth')?null:({id:req.headers['x-test-user']??'7',username:'player'}),resolveWallet:async()=>linked,fetchImpl,now:()=>clock});
  const server=createServer(async(req,res)=>{if(!await handler(req,res)){res.writeHead(404);res.end('{}');}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=async(path='/config',body,headers={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api/market${path}`,{method:body===undefined?'GET':'POST',headers:{cookie:'session=fixture',...(body===undefined?{}:{origin:ORIGIN,'content-type':'application/json','x-realm-market':'1'}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  return {request,requests,get executes(){return executes;},advance:ms=>clock+=ms,setWallet:value=>linked=value};
}

test('config authenticates and exposes only the verified linked wallet',async t=>{
  const f=await fixture(t);assert.equal((await f.request('/config',undefined,{cookie:'noauth'})).status,401);
  const result=await f.request();assert.equal(result.status,200);assert.equal(result.body.enabled,true);assert.equal(result.body.tokenDecimals,6);assert.equal(result.body.wallet,wallet);
});
test('unset CA and either disabled launch flag close exchange without contacting chain',async t=>{
  for(const env of [{ECONOMY_TOKEN_MINT:''},{TOKEN_LAUNCHED:'false'},{SWAPS_ENABLED:'false'}]) {const f=await fixture(t,{env});assert.equal((await f.request()).body.enabled,false);assert.equal((await f.request('/order',{direction:'sol-to-token',amount:'1'})).status,503);assert.equal(f.requests.length,0);}
});
test('mint configuration conflict fails closed',async t=>{
  const f=await fixture(t,{env:{GAME_TOKEN_MINT:other.publicKey.toBase58()}});assert.equal((await f.request()).body.enabled,false);
});
test('mainnet genesis, mint ownership, size, initialized flag and decimals must validate',async t=>{
  for(const options of [{genesis:'devnet'}, {account:null},{account:mintAccount({owner:SOL})},{account:mintAccount({size:165})},{account:mintAccount({initialized:0})},{account:mintAccount({executable:true})},{env:{GAME_TOKEN_DECIMALS:'9'}}]) {const f=await fixture(t,options);assert.equal((await f.request()).body.enabled,false);assert.equal((await f.request('/order',{direction:'sol-to-token',amount:'1'})).status,503);assert.equal(f.executes,0);}
});
test('POST requires exact configured origin and rejects missing origin or cross-site',async t=>{
  const f=await fixture(t);for(const origin of ['', 'https://evil.example','https://realm.example:444','http://realm.example']) assert.equal((await f.request('/order',{direction:'sol-to-token',amount:'1'},{origin})).status,403);
  assert.equal((await f.request('/order',{direction:'sol-to-token',amount:'1'},{'sec-fetch-site':'cross-site'})).status,403);assert.equal(f.requests.length,0);
});
test('wallet must be server bound; client cannot substitute pair, wallet or amount precision',async t=>{
  const f=await fixture(t);for(const body of [{direction:'sol-to-token',amount:'1',wallet:other.publicKey.toBase58()},{direction:'sol-to-token',amount:'1',inputMint:SOL},{direction:'sol-to-token',amount:1},...['0','01','1.2','-1','1e9','18446744073709551616'].map(amount=>({direction:'sol-to-token',amount}))]) assert.equal((await f.request('/order',body)).status,400);
  f.setWallet(null);assert.equal((await f.request('/order',{direction:'sol-to-token',amount:'1'})).status,409);
});
test('both fixed SOL/token directions preserve amounts above JS safe-integer exactly',async t=>{
  const f=await fixture(t);for(const direction of ['sol-to-token','token-to-sol']) {const r=await f.request('/order',{direction,amount:'18446744073709551615'});assert.equal(r.status,200);assert.equal(r.body.inAmount,'18446744073709551615');assert.equal(r.body.inputMint,direction==='sol-to-token'?SOL:mint);assert.equal(r.body.outputMint,direction==='sol-to-token'?mint:SOL);assert.ok(r.body.orderId);assert.ok(r.body.expiresAt>0);}
});
test('missing liquidity, wrong pair, wrong payer, or malformed transaction cannot issue an order',async t=>{
  for(const quote of [{transaction:''},{inputMint:other.publicKey.toBase58()},{inAmount:'2'},{outAmount:'0'},{transaction:Buffer.from(transaction(other).serialize()).toString('base64')},{transaction:'abc'}]) {const f=await fixture(t,{quote});assert.equal((await f.request('/order',{direction:'sol-to-token',amount:'1'})).status,502);}
});
test('unsigned and fake signatures fail cryptographic verification before upstream execute',async t=>{
  const f=await fixture(t);const o=(await f.request('/order',{direction:'sol-to-token',amount:'1'})).body;
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:o.transaction})).status,400);
  const tx=VersionedTransaction.deserialize(Buffer.from(o.transaction,'base64'));tx.signatures[0].fill(9);
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:Buffer.from(tx.serialize()).toString('base64')})).status,400);assert.equal(f.executes,0);
});
test('exact message, account, session, wallet and expiry bind each order',async t=>{
  const f=await fixture(t);const o=(await f.request('/order',{direction:'sol-to-token',amount:'1'})).body;
  const substitute=transaction(signer,2);substitute.sign([signer]);
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:Buffer.from(substitute.serialize()).toString('base64')})).status,400);
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)},{'x-test-user':'8'})).status,404);
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)},{cookie:'session=other'})).status,404);
  f.setWallet(other.publicKey.toBase58());assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)})).status,409);
  f.setWallet(wallet);f.advance(60001);assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)})).status,410);assert.equal(f.executes,0);
});
test('signed order executes once even with concurrent requests and terminal replay',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{execute:async()=>{await gate;return Response.json({status:'Success',code:0});}});const o=(await f.request('/order',{direction:'sol-to-token',amount:'1'})).body;const payload={orderId:o.orderId,signedTransaction:signed(o.transaction)};
  const first=f.request('/execute',payload);while(!f.executes) await new Promise(resolve=>setImmediate(resolve));
  const second=await f.request('/execute',payload);assert.equal(second.status,202);release();assert.equal((await first).body.status,'Success');
  assert.equal((await f.request('/execute',payload)).body.status,'Success');assert.equal(f.executes,1);
});
test('ambiguous upstream execute transport error stays pending and checks chain without resubmission',async t=>{
  const f=await fixture(t,{execute:async()=>{throw new Error('timeout');}});const o=(await f.request('/order',{direction:'sol-to-token',amount:'1'})).body;
  const first=await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)});assert.equal(first.status,202);assert.equal(first.body.status,'Pending');assert.ok(first.body.signature);
  const second=await f.request('/execute',{orderId:o.orderId});assert.equal(second.status,202);assert.equal(second.body.status,'Pending');assert.equal(f.executes,1);assert.ok(f.requests.some(r=>r.options.body?.includes('getSignatureStatuses')));
});
test('Jupiter string block-height expiry is accepted and an expired RFQ is rejected',async t=>{
  const f=await fixture(t,{quote:{lastValidBlockHeight:'200'}});const o=await f.request('/order',{direction:'sol-to-token',amount:'1'});assert.equal(o.status,200);assert.equal((await f.request('/execute',{orderId:o.body.orderId,signedTransaction:signed(o.body.transaction)})).body.status,'Success');
  const expired=await fixture(t,{quote:{expireAt:'2020-01-01T00:00:00Z'}});assert.equal((await expired.request('/order',{direction:'sol-to-token',amount:'1'})).status,502);
});
test('submitted transaction reaches an authoritative onchain outcome without a second upstream submission',async t=>{
  let outcome=null;
  const f=await fixture(t,{execute:async()=>Response.json({status:'Failed',code:-1001}),fetchOverride:async(url,options)=>{
    if(options.body && JSON.parse(options.body).method==='getSignatureStatuses') return Response.json({result:{value:[outcome]}});
  }});const o=(await f.request('/order',{direction:'sol-to-token',amount:'1'})).body;
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)})).body.status,'Pending');
  outcome={confirmationStatus:'confirmed',err:{InstructionError:[0,'Custom']}};
  assert.equal((await f.request('/execute',{orderId:o.orderId})).body.status,'Failed');assert.equal(f.executes,1);
});
test('quote expiry is checked again after asynchronous block-height validation',async t=>{
  let expire;
  const f=await fixture(t,{fetchOverride:async(url,options)=>{if(options.body && JSON.parse(options.body).method==='getBlockHeight') {expire();return Response.json({result:100});}}});
  expire=()=>f.advance(60001);const o=(await f.request('/order',{direction:'sol-to-token',amount:'1'})).body;
  assert.equal((await f.request('/execute',{orderId:o.orderId,signedTransaction:signed(o.transaction)})).status,410);assert.equal(f.executes,0);
});
test('valid RFQ Unix timestamp strings shorten local quote expiry',async t=>{
  const f=await fixture(t,{quote:{expireAt:'1800000010',lastValidBlockHeight:null}});const o=await f.request('/order',{direction:'sol-to-token',amount:'1'});assert.equal(o.status,200);assert.equal(o.body.expiresAt,1800000010000);
});
test('failed mint read and failed quote transport keep exchange honest',async t=>{
  const chain=await fixture(t,{fetchOverride:async(url)=>{if(String(url).startsWith('https://rpc.example/')) throw new Error('RPC down');}});assert.equal((await chain.request()).body.enabled,false);
  const quote=await fixture(t,{fetchOverride:async(url)=>{if(String(url).includes('/swap/v2/order?')) throw new Error('Jupiter down');}});assert.equal((await quote.request('/order',{direction:'sol-to-token',amount:'1'})).status,502);assert.equal(quote.executes,0);
});
