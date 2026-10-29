import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {withdrawalFixture,reserve,finalized} from './withdrawal-fixtures.mjs';

for(const restartBefore of [false,true])test(`finalized successful withdrawal with null blockTime settles once across restart (restart before: ${restartBefore})`,async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');await f.k.broadcastWithdrawal(1,'withdraw1');
 finalized(f.deps,signed).blockTime=null;if(restartBefore)f.restart({signer:null});
 const settled=await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(settled.state,'settled');assert.equal(settled.result.chainReceipt.blockTime,null);
 assert.deepEqual(f.k.totals(),{reserveAtoms:'9000',claimsAtoms:'9000'});assert.equal(f.k.balance(1).vaultAtoms,'9000');assert.deepEqual(f.k.pendingWithdrawals().entries,[]);
 const db=new DatabaseSync(f.path);try{const proof=JSON.parse(db.prepare("SELECT payload FROM ac_receipts WHERE operation_id='withdraw1'").get().payload);assert.equal(proof.chainReceipt.blockTime,null);assert.equal(db.prepare("SELECT COUNT(*) n FROM ac_locks WHERE operation_id='withdraw1'").get().n,0);}finally{db.close();}
 f.restart({rpc:null,archiveRpc:null,signer:null});assert.deepEqual((await f.k.reconcileWithdrawal(1,'withdraw1')).result,settled.result);assert.deepEqual(f.k.totals(),{reserveAtoms:'9000',claimsAtoms:'9000'});
});

test('finalized recognized failure retains raw null blockTime when releasing once',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');finalized(f.deps,signed,{err:{InstructionError:[0,'InsufficientFunds']}}).blockTime=null;
 const result=await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(result.state,'failed');assert.equal(result.result.chainReceipt.blockTime,null);f.restart();assert.equal((await f.k.reconcileWithdrawal(1,'withdraw1')).result.chainReceipt.blockTime,null);assert.equal(f.k.balance(1).vaultAtoms,'10000');
});

for(const err of [null,{InstructionError:[0,'InsufficientFunds']}])for(const blockTime of [undefined,'1700000000',false,{},-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])test(`malformed non-null blockTime keeps ${err?'failure':'success'} withdrawal held: ${String(blockTime)}`,async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');finalized(f.deps,signed,{err}).blockTime=blockTime;
 assert.equal((await f.k.reconcileWithdrawal(1,'withdraw1')).state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'9000');assert.deepEqual(f.k.totals(),{reserveAtoms:'10000',claimsAtoms:'10000'});f.restart();assert.equal(f.k.pendingWithdrawals().entries[0].id,'withdraw1');
});
