import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Exercise the same browser module as the shipped asset, with no DOM mount,
// provider connection or signature request.
const artifact=await build({entryPoints:[fileURLToPath(new URL('../wallet-ui.mjs',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:['es2022'],loader:{'.css':'empty'},write:false});
const previousLocation=globalThis.location;
globalThis.location={pathname:'/wallet-presentation-test'};
let presentation;
try {presentation=await import(`data:text/javascript;base64,${Buffer.from(artifact.outputFiles[0].contents).toString('base64')}`);}
finally {if(previousLocation===undefined)delete globalThis.location;else globalThis.location=previousLocation;}

const balance=(overrides={})=>({available:true,cluster:'devnet',genesisVerified:true,solLamports:'1',commitment:'finalized',displayOnly:true,...overrides});

test('wallet presentation preserves exact native lamports and names the network',()=>{
  assert.equal(typeof presentation.solBalanceText,'function');
  const one=presentation.solBalanceText(balance(),'devnet');
  assert.match(one,/0\.000000001 SOL/);
  assert.match(one,/Solana devnet/);
  assert.match(one,/test SOL/);
  assert.match(one,/display only/);
  const large=presentation.solBalanceText(balance({cluster:'mainnet-beta',solLamports:'9007199254740993'}),'mainnet-beta');
  assert.match(large,/9007199\.254740993 SOL/);
  assert.match(large,/Solana mainnet-beta/);
  assert.doesNotMatch(large,/test SOL/);
});

test('wallet presentation never turns a mismatched network or unproven balance into SOL',()=>{
  assert.equal(typeof presentation.solBalanceText,'function');
  for(const input of [balance({cluster:'mainnet-beta'}),balance({genesisVerified:false}),balance({genesisVerified:undefined}),balance({commitment:'confirmed'}),balance({displayOnly:false}),balance({solLamports:1}),balance({solLamports:'01'}),balance({solLamports:'1e9'}),balance({solLamports:'18446744073709551616'})]) {
    assert.throws(()=>presentation.solBalanceText(input,'devnet'));
  }
  assert.throws(()=>presentation.solBalanceText(balance(),'testnet'));
});

test('unavailable wallet reads retain network context without inventing a balance',()=>{
  assert.equal(typeof presentation.solBalanceText,'function');
  const text=presentation.solBalanceText({available:false,cluster:'devnet',reason:'Link a wallet to view chain balances.'},'devnet');
  assert.match(text,/Solana devnet/);
  assert.match(text,/Link a wallet/);
  assert.doesNotMatch(text,/0 SOL/);
});
