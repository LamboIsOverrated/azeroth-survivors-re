import test from 'node:test';
import assert from 'node:assert/strict';
import {withdrawalFixture,reserve,finalized} from './withdrawal-fixtures.mjs';

const malformed=[{},'', 'failed','UnknownFutureError',{InstructionError:[0,'InsufficientFunds'],extra:true},{InstructionError:[]},{InstructionError:[0]},{InstructionError:[0,'InsufficientFunds','extra']},{InstructionError:['0','InsufficientFunds']},{InstructionError:[-1,'InsufficientFunds']},{InstructionError:[256,'InsufficientFunds']},{InstructionError:[2,'InsufficientFunds']},{InstructionError:[0,{}]},{InstructionError:[0,'UnknownFutureInstructionError']},{InstructionError:[0,{Custom:-1}]},{InstructionError:[0,{Custom:4294967296}]},{InstructionError:[0,{Custom:'1'}]},{InstructionError:[0,{Custom:1.5}]},{InstructionError:[0,{Custom:1,extra:true}]},{DuplicateInstruction:256},{InsufficientFundsForRent:{account_index:-1}},{InsufficientFundsForRent:{account_index:0,extra:true}},{ProgramExecutionTemporarilyRestricted:{account_index:'0'}},{BlockhashNotFound:null}];
for(const err of malformed)test('malformed finalized withdrawal error '+JSON.stringify(err)+' cannot release claims',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');
 const proof=finalized(f.deps,signed,{err});proof.meta.postTokenBalances=structuredClone(proof.meta.preTokenBalances);
 await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'9000');assert.equal(f.k.totals().claimsAtoms,'10000');
});

test('a recognized failure with successful or partial token movement is contradictory and never refunds',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1'),err={InstructionError:[0,{Custom:1}]};
 const proof=finalized(f.deps,signed);proof.meta.err=err;f.deps.rpc.statuses.get(signed.signature).err=err;
 await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'9000');
 proof.meta.postTokenBalances[0].uiTokenAmount.amount='9999';proof.meta.postTokenBalances[1].uiTokenAmount.amount='1';
 await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'9000');
});

test('recognized exact InstructionError failures with unchanged bound token balances release once',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');
 finalized(f.deps,signed,{err:{InstructionError:[0,{Custom:4294967295}]}});
 await f.k.reconcileWithdrawal(1,'withdraw1');await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'failed');assert.equal(f.k.balance(1).vaultAtoms,'10000');assert.equal(f.k.totals().reserveAtoms,'10000');
});
