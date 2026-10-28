import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccounting} from '../kernel.mjs';
import {configuration} from '../amounts.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';
import {eventWorld} from './event-fixtures.mjs';
for(const mode of ['competing','same','crash'])test('multi-owner '+mode+' OS process reservations remain atomic after process exit',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'event-process-')),path=join(dir,'live.sqlite'),config=configuration(input),deps=dependencies(config);eventWorld(deps.world,config);let k=createAccounting({path,config,...deps});const workers=[];
 try{
  await deposit(k,deps);await deposit(k,deps,{id:'dep2',accountId:2});
  for(const [accountId,guid,units]of [[1,'10','30'],[2,'20','20']]){await k.prepareWorld({id:'seed'+guid,accountId,guid,kind:'grant',units});await k.advanceWorld(accountId,'seed'+guid);}
  k.close();k=null;
  for(const id of (mode==='crash'?['offer1']:['offer1','offer2'])){
   const child=fork(fileURLToPath(new URL('./event-worker.mjs',import.meta.url)),[path,id,mode],{stdio:['ignore','ignore','pipe','ipc']});workers.push(child);let errors='';child.stderr.on('data',data=>errors+=data);
   const [ready]=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Early worker exit: '+errors);})]);assert.equal(ready,'ready');
  }
  const results=await Promise.all(workers.map(async child=>{const message=once(child,'message'),exit=once(child,'exit');child.send('go');const [result]=await message;await exit;return result;}));
  assert.equal(results.filter(x=>x.ok).length,mode==='same'?2:1);
  k=createAccounting({path,config,...deps});assert.equal(k.balance(1).worldAtoms,'500');assert.equal(k.balance(2).worldAtoms,'2000');assert.equal(k.totals().claimsAtoms,'20000');
  const id=mode==='same'?'shared':results[0].ok?'offer1':'offer2';await k.advanceEvent(1,id);
  assert.equal(k.character(1,'10').moneyUnits,'5');assert.equal(k.character(2,'20').moneyUnits,'45');assert.equal(deps.world.eventCommitCalls,1);
 }finally{for(const c of workers)if(c.connected)c.kill();k?.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
