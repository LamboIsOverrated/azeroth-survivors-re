import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configuration} from '../amounts.mjs';
import {createAccounting} from '../kernel.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';

const grant={id:'op1',accountId:1,guid:'10',kind:'grant',units:'10'};
test('only verified exact finalized deposits fund claims; intent/account/signature replay cannot credit twice',async()=>{
 const cfg=configuration(input),deps=dependencies(cfg),k=createAccounting({path:':memory:',config:cfg,...deps});
 try{
  const proof=await deposit(k,deps,{amount:'9007199254740993'});
  assert.equal(k.balance(1).vaultAtoms,'9007199254740993');
  await k.confirmDeposit({accountId:1,id:'deposit1',signature:proof.signature});
  await assert.rejects(k.confirmDeposit({accountId:2,id:'deposit1',signature:proof.signature}));
  await assert.rejects(k.createDeposit({accountId:2,id:'deposit1',atoms:'9007199254740993',sourceTokenAccount:proof.intent.sourceTokenAccount}));
  const old=deps.rpc.receipts.get(proof.signature);deps.rpc.receipts.set(proof.signature,{...old,meta:{...old.meta,err:{bad:true}}});
  // Durable replay uses the original verified record, without accepting replacement proof.
  await k.confirmDeposit({accountId:1,id:'deposit1',signature:proof.signature});
  assert.equal(k.totals().reserveAtoms,'9007199254740993');
 }finally{k.close();}
});
test('world grants reserve before apply and require matching durable receipt then acknowledgement; redemption conserves',async()=>{
 const cfg=configuration(input),deps=dependencies(cfg),k=createAccounting({path:':memory:',config:cfg,...deps});
 try{
  await deposit(k,deps);await k.prepareWorld(grant);
  assert.equal(k.balance(1).vaultAtoms,'9000');assert.equal(k.operation(1,'op1').state,'reserved');assert.equal(deps.world.applyCalls,0);
  assert.equal((await k.advanceWorld(1,'op1')).state,'complete');
  assert.equal(k.character(1,'10').moneyUnits,'10');assert.equal(k.balance(1).worldAtoms,'1000');
  await k.prepareWorld({...grant,id:'redeem1',kind:'redeem',units:'3'});await k.advanceWorld(1,'redeem1');
  assert.equal(k.balance(1).vaultAtoms,'9300');assert.equal(k.balance(1).worldAtoms,'700');assert.deepEqual(k.totals(),{reserveAtoms:'10000',claimsAtoms:'10000'});
  await assert.rejects(k.prepareWorld({...grant,accountId:2}));
  await assert.rejects(k.prepareWorld({...grant,id:'x',accountId:2,guid:'10'}));
  await assert.rejects(k.prepareWorld({...grant,units:'11'}));
 }finally{k.close();}
});
test('restart across reserved, committed world/lost response, durable finalize/lost ack never reapplies or releases twice',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'accounting-crash-')),path=join(dir,'live.sqlite'),cfg=configuration(input),deps=dependencies(cfg);
 let k=createAccounting({path,config:cfg,...deps});
 try{
  await deposit(k,deps);await k.prepareWorld(grant);k.close();k=createAccounting({path,config:cfg,...deps});
  deps.world.lostApply=true;await assert.rejects(k.advanceWorld(1,'op1'));assert.equal(k.operation(1,'op1').state,'reserved');
  k.close();k=createAccounting({path,config:cfg,...deps});deps.world.lostApply=false;deps.world.lostAck=true;
  await assert.rejects(k.advanceWorld(1,'op1'));assert.equal(k.operation(1,'op1').state,'awaiting_ack');assert.equal(k.balance(1).worldAtoms,'1000');
  await assert.rejects(k.prepareWorld({...grant,id:'blocked'}));
  k.close();k=createAccounting({path,config:cfg,...deps});deps.world.lostAck=false;
  await k.advanceWorld(1,'op1');await k.advanceWorld(1,'op1');
  assert.equal(deps.world.applyCalls,1);assert.equal(k.balance(1).worldAtoms,'1000');assert.equal(k.operation(1,'op1').state,'complete');
 }finally{k.close();rmSync(dir,{recursive:true,force:true});}
});
test('foreign/TEST/tampered receipt stays reserved; proven rejection restores once and admits only tracked zero characters',async()=>{
 const cfg=configuration(input),deps=dependencies(cfg),k=createAccounting({path:':memory:',config:cfg,...deps});
 try{
  await deposit(k,deps);await k.prepareWorld(grant);deps.world.reject=true;deps.world.lostApply=true;
  await assert.rejects(k.advanceWorld(1,'op1'));const good=deps.world.receipts.get('op1');
  for(const change of [{phase:'TEST'},{accountId:2},{namespaceId:'other'},{units:'11'},{afterUnits:'10'},{beforeVersion:'1'},{configHash:'x'},{reason:'unknown'}]){
   deps.world.receipts.set('op1',{...good,...change});await assert.rejects(k.advanceWorld(1,'op1'));assert.equal(k.balance(1).vaultAtoms,'9000');
  }
  deps.world.receipts.set('op1',good);await k.advanceWorld(1,'op1');await k.advanceWorld(1,'op1');assert.equal(k.balance(1).vaultAtoms,'10000');
  deps.world.characters.set('20',{...deps.world.character(1,'20'),moneyUnits:'1'});
  await assert.rejects(k.prepareWorld({...grant,id:'stock',guid:'20'}));
 }finally{k.close();}
});
test('funded pools reserve before issuance; authoritative event replay/cross-account conflict and unfunded rewards reject',async()=>{
 const cfg=configuration(input),deps=dependencies(cfg),k=createAccounting({path:':memory:',config:cfg,...deps});
 const reward={...grant,id:'reward1',kind:'issue',poolId:'rewards',eventId:'quest:server:1',reason:'quest',units:'2'};
 try{
  await assert.rejects(k.prepareWorld(reward));await deposit(k,deps);
  k.fundPool({id:'fund1',accountId:1,poolId:'rewards',atoms:'555'});k.fundPool({id:'fund1',accountId:1,poolId:'rewards',atoms:'555'});
  assert.throws(()=>k.fundPool({id:'fund1',accountId:2,poolId:'rewards',atoms:'555'}));
  await k.prepareWorld(reward);assert.equal(k.pool('rewards').availableAtoms,'355');await k.advanceWorld(1,'reward1');
  await assert.rejects(k.prepareWorld({...reward,id:'reward2'}));
  await assert.rejects(k.prepareWorld({...reward,id:'reward3',eventId:'quest:server:2',reason:'client-kill'}));
  await k.prepareWorld({...grant,id:'sink',kind:'sink',poolId:'rewards',units:'1'});await k.advanceWorld(1,'sink');
  assert.equal(k.pool('rewards').availableAtoms,'455');assert.equal(k.balance(1).worldAtoms,'100');assert.equal(k.balance(1).vaultAtoms,'9445');
  assert.equal(k.totals().claimsAtoms,'10000');
 }finally{k.close();}
});
