import test from 'node:test';
import assert from 'node:assert/strict';
import {AddressLookupTableAccount,AddressLookupTableProgram,Keypair,PublicKey,SystemProgram,TransactionInstruction,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {validateRoute} from '../validate-route.mjs';
import {routeFixture,TOKEN,SOL,RAY} from './route-fixture.mjs';
const wallet=Keypair.fromSeed(new Uint8Array(32).fill(29)).publicKey.toBase58(),mint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
function context({direction='sol-to-token',amount='1000000',options={}}={}) {
  const fixture=routeFixture(wallet,mint,amount,direction,options);const calls=[];
  const rpc=async(method,params)=>{
    calls.push({method,params});
    const empty={owner:PublicKey.default.toBase58(),lamports:1,executable:false,data:['','base64']};
    if(method==='getMultipleAccounts') return {context:{slot:1000},value:params[0].map(key=>fixture.before.get(key)??empty)};
    if(method==='getFeeForMessage') return {value:5000};
    if(method==='simulateTransaction')return {context:{slot:1000},value:{err:null,accounts:params[1].accounts.addresses.map(key=>fixture.after.has(key)?fixture.after.get(key):fixture.before.get(key)??empty)}};
    throw new Error(`Unexpected ${method}`);
  };
  const args={tx:fixture.tx,wallet,inputMint:direction==='sol-to-token'?SOL:mint,outputMint:direction==='sol-to-token'?mint:SOL,amount,quotedOutAmount:'2000000',rpc};
  return {fixture,args,calls};
}
test('supported Jupiter/Raydium buy and sell bind encoded minimum output and audited wallet deltas',async()=>{
  for(const direction of ['sol-to-token','token-to-sol']) {const {args,calls}=context({direction});const result=await validateRoute(args);assert.equal(result.minimumOut,'1980000');assert.equal(result.networkFeeLamports,'5000');assert.equal(calls.at(-1).method,'simulateTransaction');}
});
test('appended SOL transfers and token authority changes are rejected despite successful-looking simulation',async()=>{
  const authority=new TransactionInstruction({programId:new PublicKey(TOKEN),keys:[],data:Buffer.from([6,1,0,0,0])});
  const transfer=SystemProgram.transfer({fromPubkey:new PublicKey(wallet),toPubkey:new PublicKey(mint),lamports:1});
  for(const extraInstructions of [[authority],[transfer]]) await assert.rejects(()=>validateRoute(context({options:{extraInstructions}}).args));
});
test('unknown methods, nonzero platform fee and excessive instruction slippage fail closed',async()=>{
  for(const mutation of [data=>data[0]^=1,data=>data[34]=1,data=>data.writeUInt16LE(101,32)]) {
    const {args}=context();const instruction=args.tx.message.compiledInstructions.find(row=>row.data.length===35);mutation(instruction.data);await assert.rejects(()=>validateRoute(args));
  }
  await assert.rejects(()=>validateRoute({...context().args,maxSlippageBps:50}));
});
test('simulated loss of minimum output, unexpected SOL debit or delegate grant rejects the quote',async()=>{
  for(const kind of ['output','sol','delegate']) {
    const c=context();const output=[...c.fixture.after.entries()].find(([key,value])=>key!==wallet && value?.owner===TOKEN && Buffer.from(value.data[0],'base64').subarray(32,64).equals(new PublicKey(wallet).toBuffer()));
    if(kind==='sol') c.fixture.after.set(wallet,{...c.fixture.after.get(wallet),lamports:c.fixture.after.get(wallet).lamports-1});
    else {const account={...output[1]},data=Buffer.from(account.data[0],'base64');if(kind==='output') data.writeBigUInt64LE(1979999n,64);else data.writeUInt32LE(1,72);account.data=[data.toString('base64'),'base64'];c.fixture.after.set(output[0],account);}
    await assert.rejects(()=>validateRoute(c.args));
  }
});
test('an executable substitution for the DEX program is rejected before simulation',async()=>{
  const c=context();c.fixture.before.set(RAY,{...c.fixture.before.get(RAY),executable:false});await assert.rejects(()=>validateRoute(c.args));assert.equal(c.calls.some(call=>call.method==='simulateTransaction'),false);
});
test('address lookup table contents are resolved only from the fixed RPC and verified by their program',async()=>{
  const c=context(),tableKey=new PublicKey(new Uint8Array(32).fill(213));
  const decompiled=TransactionMessage.decompile(c.args.tx.message);
  const table=new AddressLookupTableAccount({key:tableKey,state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,authority:undefined,addresses:c.args.tx.message.staticAccountKeys.slice(2)}});
  const tx=new VersionedTransaction(decompiled.compileToV0Message([table]));assert.equal(tx.message.addressTableLookups.length,1);
  const data=Buffer.alloc(56+table.state.addresses.length*32);data.writeUInt32LE(1,0);data.writeBigUInt64LE(18446744073709551615n,4);data.writeBigUInt64LE(1n,12);for(const [index,key] of table.state.addresses.entries()) key.toBuffer().copy(data,56+index*32);
  const tableAccount={owner:AddressLookupTableProgram.programId.toBase58(),executable:false,lamports:1,data:[data.toString('base64'),'base64']};
  const rpc=async(method,params)=>{if(method==='getAccountInfo') {assert.equal(params[0],tableKey.toBase58());return {value:tableAccount};}return c.args.rpc(method,params);};
  assert.equal((await validateRoute({...c.args,tx,rpc})).minimumOut,'1980000');
  tableAccount.owner=TOKEN;await assert.rejects(()=>validateRoute({...c.args,tx,rpc}));
});
