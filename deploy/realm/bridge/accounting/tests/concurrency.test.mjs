import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {createAccounting} from '../kernel.mjs';
import {configuration} from '../amounts.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';

for(const mode of ['competing','same-operation'])test('OS processes '+mode+' preserve one reserve and exact idempotency',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'accounting-process-')),path=join(dir,'live.sqlite'),cfg=configuration(input),deps=dependencies(cfg);
 let kernel=createAccounting({path,config:cfg,...deps});const workers=[];
 try{
  await deposit(kernel,deps);kernel.close();kernel=null;
  for(const id of ['poolA','poolB']){
   const child=fork(fileURLToPath(new URL('./process-worker.mjs',import.meta.url)),[path,id,mode],{stdio:['ignore','ignore','pipe','ipc']});workers.push(child);
   let errors='';child.stderr.on('data',data=>errors+=data);const ready=await Promise.race([once(child,'message'),once(child,'exit').then(()=>{throw Error('Worker exited early: '+errors);})]);assert.equal(ready[0],'ready');
  }
  const outcomes=workers.map(async child=>{const message=once(child,'message'),exit=once(child,'exit');child.send('go');const [result]=await message;await exit;return result;});
  const results=await Promise.all(outcomes);assert.equal(results.filter(x=>x.ok).length,mode==='competing'?1:2);
  kernel=createAccounting({path,config:cfg,...deps});assert.equal(kernel.balance(1).vaultAtoms,'3000');assert.equal(kernel.totals().reserveAtoms,'10000');assert.equal(kernel.totals().claimsAtoms,'10000');
 }finally{for(const child of workers)if(child.connected)child.kill();kernel?.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
