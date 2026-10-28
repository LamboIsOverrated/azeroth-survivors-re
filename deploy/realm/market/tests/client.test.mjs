import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { parseUnits,formatUnits,chooseProvider,createMarketSession } from '../client.mjs';
import {routeFixture} from './route-fixture.mjs';
const signer=Keypair.fromSeed(new Uint8Array(32).fill(37)),other=Keypair.fromSeed(new Uint8Array(32).fill(38));
const wallet=signer.publicKey.toBase58();
const tx=()=>routeFixture(wallet,other.publicKey.toBase58(),'1000000000').tx;
test('decimal entry preserves all u64 digits and rejects rounding, exponents and excess precision',()=>{
  assert.equal(parseUnits('18446744073.709551615',9),'18446744073709551615');
  assert.equal(parseUnits('0.000001',6),'1');assert.equal(formatUnits('1000001',6),'1.000001');
  for(const value of ['18446744073.709551616','0.0000000001','1e3','-1','0']) assert.throws(()=>parseUnits(value,9));
});
test('only an injected signing provider matching the verified linked wallet is selected',()=>{
  const phantom={isPhantom:true,publicKey:other.publicKey,signTransaction:async()=>{}},solflare={publicKey:signer.publicKey,signTransaction:async()=>{}};
  assert.equal(chooseProvider(wallet,{phantom:{solana:phantom},solflare}),solflare);
  assert.throws(()=>chooseProvider(wallet,{phantom:{solana:phantom}}));
});
function sessionFixture({execute,provider}={}) {
  let signs=0;const calls=[];const injected=provider??{publicKey:signer.publicKey,signTransaction:async transaction=>{signs++;transaction.sign([signer]);return transaction;}};
  const fetchImpl=async(path,options)=>{
    calls.push({path,body:options.body?JSON.parse(options.body):undefined});
    if(path==='/api/market/config') return Response.json({enabled:true,tokenDecimals:6,tokenSymbol:'GAME',wallet,tokenMint:other.publicKey.toBase58()});
    if(path==='/api/market/order') return Response.json({orderId:'order-fixture',transaction:Buffer.from(tx().serialize()).toString('base64'),expiresAt:Date.now()+60000,inAmount:'1000000000',outAmount:'1000000',inputMint:'So11111111111111111111111111111111111111112',outputMint:other.publicKey.toBase58()});
    if(path==='/api/market/execute') return execute?execute():Response.json({status:'Success',signature:'offline-fixture-signature'});
    throw new Error('Unexpected request');
  };
  return {session:createMarketSession({fetchImpl,scope:{phantom:{solana:injected}}}),calls,get signs(){return signs;}};
}
test('quoting never prompts signing; reviewed quote requires separate explicit submission',async()=>{
  const f=sessionFixture();await f.session.refresh();await f.session.requestQuote('sol-to-token','1');assert.equal(f.signs,0);assert.equal(f.session.state.phase,'review');
  const result=await f.session.signAndExecute();assert.equal(f.signs,1);assert.equal(result.status,'Success');assert.equal(f.calls.filter(c=>c.path==='/api/market/execute').length,1);
});
test('wallet message substitution is rejected before execute and a pending request cannot start a new swap',async()=>{
  const bad=sessionFixture({provider:{publicKey:signer.publicKey,signTransaction:async()=>{const otherTx=tx();otherTx.message.recentBlockhash=other.publicKey.toBase58();otherTx.sign([signer]);return otherTx;}}});
  await bad.session.refresh();await bad.session.requestQuote('sol-to-token','1');await assert.rejects(()=>bad.session.signAndExecute(),/differs|changed/);assert.equal(bad.calls.filter(c=>c.path==='/api/market/execute').length,0);
  const f=sessionFixture({execute:async()=>{throw new Error('network timeout');}});await f.session.refresh();await f.session.requestQuote('sol-to-token','1');assert.equal((await f.session.signAndExecute()).status,'Pending');assert.equal(f.session.state.phase,'pending');await assert.rejects(()=>f.session.requestQuote('sol-to-token','1'),/pending/i);
});
