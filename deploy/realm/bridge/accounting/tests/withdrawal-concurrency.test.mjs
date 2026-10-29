import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {withdrawalFixture,reserve} from './withdrawal-fixtures.mjs';
import {deposit} from './fixtures.mjs';

for(const mode of ['competing','same','crash','prepare','across'])test('withdrawal OS process '+mode+' preserves one durable claim and one submitted transaction identity',{timeout:15000},async t=>{
 const f=await withdrawalFixture(t),workers=[];
 try{
  if(mode==='prepare')await reserve(f.k,'shared');
  if(mode==='across')await deposit(f.k,f.deps,{accountId:2,id:'dep2'});
  for(const id of mode==='crash'?['a']:['a','b']){
   const child=fork(new URL('./withdrawal-worker.mjs',import.meta.url),[f.path,id,mode],{stdio:['ignore','ignore','pipe','ipc']});workers.push(child);
   let errors='';child.stderr.on('data',data=>errors+=data);const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Withdrawal worker exited: '+errors);})]);assert.equal(ready[0],'ready');
  }
  const outcomes=workers.map(async child=>{const exit=once(child,'exit'),message=mode==='crash'?null:once(child,'message');child.send('go');const result=message?(await message)[0]:null;await exit;return result;});
  const results=await Promise.all(outcomes);f.restart();
  if(mode==='prepare'){
   assert.equal(results.filter(r=>r.ok).length,2);assert.equal(new Set(results.map(r=>r.signature)).size,1);assert.equal(new Set(results.map(r=>r.bytes)).size,1);assert.equal(f.k.withdrawal(1,'shared').state,'pending');assert.equal(f.k.balance(1).vaultAtoms,'9000');
  }else if(mode==='across'){
   assert.equal(results.filter(r=>r.ok).length,2);assert.equal(f.k.pendingWithdrawals().entries.length,2);assert.equal(f.k.balance(1).vaultAtoms,'3000');assert.equal(f.k.balance(2).vaultAtoms,'3000');
  }else{
   if(mode!=='crash')assert.equal(results.filter(r=>r.ok).length,mode==='same'?2:1);
   assert.equal(f.k.pendingWithdrawals().entries.length,1);assert.equal(f.k.balance(1).vaultAtoms,'3000');
  }
  assert.deepEqual(f.k.totals(),mode==='across'?{reserveAtoms:'20000',claimsAtoms:'20000'}:{reserveAtoms:'10000',claimsAtoms:'10000'});
 }finally{for(const child of workers)if(child.connected)child.kill();}
});
