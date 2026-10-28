import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccounting} from '../kernel.mjs';
import {configuration} from '../amounts.mjs';
import {input,dependencies} from './fixtures.mjs';
import {receipt,source,treasury,tokenInfo,config as chain,NOW} from '../../../economy/settlement/tests/fixtures.mjs';
import {signatureOf} from '../../../economy/settlement/protocol.mjs';

for(const failure of ['pending','failed','wrong-chain','wrong-mint','short-reserve','wrong-domain','expired','tampered-signature','wrong-slot','stale-reserve'])test('deposit '+failure+' cannot create backing or claims',async()=>{
 const cfg=configuration(input),deps=dependencies(cfg),k=createAccounting({path:':memory:',config:cfg,...deps});
 try{
  let intent=await k.createDeposit({accountId:1,id:'test',atoms:'1000',sourceTokenAccount:source});
  if(failure==='wrong-domain')intent={...intent,memo:'realm-test:foreign'};
  const {row,tx}=receipt(intent),signature=signatureOf(tx);
  deps.rpc.receipts.set(signature,row);deps.rpc.statuses.set(signature,{err:null,confirmationStatus:'finalized',slot:row.slot});deps.rpc.tokens.set(treasury,tokenInfo(chain.treasuryWallet,'1000'));
  if(failure==='pending')deps.rpc.statuses.get(signature).confirmationStatus='confirmed';
  if(failure==='failed')deps.rpc.statuses.get(signature).err={InstructionError:[0,'failed']};
  if(failure==='wrong-slot')deps.rpc.statuses.get(signature).slot++;
  if(failure==='expired')row.blockTime=NOW/1000+1000;
  if(failure==='tampered-signature'){const b=Buffer.from(row.transaction[0],'base64');b[1]^=1;row.transaction[0]=b.toString('base64');}
  if(failure==='short-reserve')deps.rpc.tokens.set(treasury,tokenInfo(chain.treasuryWallet,'999'));
  if(failure==='stale-reserve')deps.rpc.slot=0;
  if(failure==='wrong-chain'){const original=deps.rpc.call;deps.rpc.call=async(method,args)=>method==='getGenesisHash'?source:original(method,args);}
  if(failure==='wrong-mint'){const original=deps.rpc.call;deps.rpc.call=async(method,args)=>{const response=await original(method,args);if(method==='getAccountInfo'&&args[0]===cfg.mint)response.value.owner='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';return response;};}
  await assert.rejects(k.confirmDeposit({accountId:1,id:'test',signature}));assert.deepEqual(k.totals(),{reserveAtoms:'0',claimsAtoms:'0'});assert.equal(k.balance(1).vaultAtoms,'0');
 }finally{k.close();}
});
