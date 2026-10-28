import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccounting} from '../kernel.mjs';
import {configuration,hash} from '../amounts.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';
import {eventWorld,character,escrow,pool,quote} from './event-fixtures.mjs';
import {applyPreparedLegs} from '../authority.mjs';

async function fixture(path=':memory:'){
 const config=configuration(input),deps=dependencies(config);eventWorld(deps.world,config);
 const k=createAccounting({path,config,...deps});await deposit(k,deps);
 for(const [accountId,guid,units] of [[1,'10','30'],[2,'20','20']]){
  if(accountId===2)await deposit(k,deps,{accountId,id:'dep2',amount:'10000'});
  await k.prepareWorld({id:'seed'+guid,accountId,guid,kind:'grant',units});await k.advanceWorld(accountId,'seed'+guid);
 }
 return {k,deps,config,path};
}
const trade=()=>quote({id:'trade1',family:'trade',participants:[{accountId:1,guid:'10'},{accountId:2,guid:'20'}],legs:[{id:'offer-a',from:character(1,'10'),to:character(2,'20'),units:'12'},{id:'offer-b',from:character(2,'20'),to:character(1,'10'),units:'3'}]});
test('one trade reserves both gross offers, applies and acknowledges all participants once without a pool',async()=>{
 const {k,deps}=await fixture();try{
  const plan=trade();await k.prepareEvent(plan);await k.prepareEvent(plan);
  assert.equal(k.balance(1).worldAtoms,'1800');assert.equal(k.balance(2).worldAtoms,'1700');
  assert.equal(k.event(1,'trade1').state,'reserved');assert.equal(deps.world.eventApplyCalls,0);
  await assert.rejects(k.advanceWorld(1,'trade1'));assert.equal(deps.world.applyCalls,2);
  await assert.rejects(k.prepareWorld({id:'blocked',accountId:1,guid:'10',kind:'redeem',units:'1'}));
  await Promise.all([k.advanceEvent(1,'trade1'),k.advanceEvent(1,'trade1')]);await k.advanceEvent(1,'trade1');
  assert.equal(k.character(1,'10').moneyUnits,'21');assert.equal(k.character(2,'20').moneyUnits,'29');
  assert.equal(k.totals().claimsAtoms,'20000');assert.equal(deps.world.eventCommitCalls,1);assert.equal(k.pool('rewards').availableAtoms,'0');
  await assert.rejects(k.prepareEvent({...plan,accountId:2}));
 }finally{k.close();}
});
test('gross overdraft, second accept, foreign domain, omitted actor and forged extra leg never partially settle',async()=>{
 const {k,deps}=await fixture();try{
  await assert.rejects(k.prepareEvent({...trade(),id:'overdraft',eventId:'overdraft',legs:[{id:'a',from:character(1,'10'),to:character(2,'20'),units:'31'},{id:'b',from:character(2,'20'),to:character(1,'10'),units:'20'}]}));
  assert.equal(k.balance(1).worldAtoms,'3000');assert.equal(k.balance(2).worldAtoms,'2000');
  await k.prepareEvent(trade());await assert.rejects(k.prepareEvent({...trade(),id:'accept2'}));
  deps.world.eventLostApply=true;await assert.rejects(k.advanceEvent(1,'trade1'));
  const good=deps.world.eventReceipts.get('trade1');
  for(const change of [{phase:'TEST'},{namespaceId:'foreign'},{configHash:hash('foreign')},{accountId:2},{eventId:'foreign'},{requestHash:hash('other')},{participants:good.participants.slice(0,1)},{legs:[...good.legs,{...good.legs[0],id:'nested-reward'}]},{planDigest:'0'.repeat(64)}]){
   deps.world.eventReceipts.set('trade1',{...good,...change});await assert.rejects(k.advanceEvent(1,'trade1'));
   assert.equal(k.balance(1).worldAtoms,'1800');assert.equal(k.balance(2).worldAtoms,'1700');assert.equal(k.event(1,'trade1').state,'reserved');
  }
  deps.world.eventReceipts.set('trade1',good);await k.advanceEvent(1,'trade1');assert.equal(k.character(1,'10').moneyUnits,'21');
 }finally{k.close();}
});
test('unknown apply and lost accounting ack recover after restart without releasing one actor early',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'multi-event-'));let {k,deps,config,path}=await fixture(join(dir,'live.sqlite'));
 try{
  await k.prepareEvent(trade());k.close();k=createAccounting({path,config,...deps});
  deps.world.eventLostApply=true;await assert.rejects(k.advanceEvent(1,'trade1'));k.close();k=createAccounting({path,config,...deps});
  deps.world.eventLostApply=false;deps.world.eventLostAck=true;await assert.rejects(k.advanceEvent(1,'trade1'));
  assert.equal(k.event(1,'trade1').state,'awaiting_ack');assert.equal(k.character(2,'20').moneyUnits,'29');
  await assert.rejects(k.prepareEvent({...trade(),id:'locked',eventId:'locked'}));
  k.close();k=createAccounting({path,config,...deps});deps.world.eventLostAck=false;await k.advanceEvent(1,'trade1');
  assert.equal(k.event(1,'trade1').state,'complete');assert.equal(deps.world.eventCommitCalls,1);
 }finally{k.close();rmSync(dir,{recursive:true,force:true});}
});
test('one rejected batch restores every gross hold once, without any partial recipient credit',async()=>{
 const {k,deps}=await fixture();try{
  await k.prepareEvent(trade());deps.world.eventReject=true;await k.advanceEvent(1,'trade1');await k.advanceEvent(1,'trade1');
  assert.equal(k.balance(1).worldAtoms,'3000');assert.equal(k.balance(2).worldAtoms,'2000');assert.equal(k.character(1,'10').moneyUnits,'30');
 }finally{k.close();}
});
test('group issuance reserves total backing and separate quest money sites cannot inherit a broad pool permit',async()=>{
 const {k,deps}=await fixture();try{
  const reward=quote({id:'quest1',family:'quest-reward',participants:[{accountId:1,guid:'10'},{accountId:2,guid:'20'}],legs:[{id:'xp-conversion',from:pool('rewards'),to:character(1,'10'),units:'3'},{id:'quest-reward',from:pool('rewards'),to:character(1,'10'),units:'2'},{id:'group-member',from:pool('rewards'),to:character(2,'20'),units:'4'}]});
  k.fundPool({id:'fund',accountId:1,poolId:'rewards',atoms:'800'});await assert.rejects(k.prepareEvent(reward));assert.equal(k.pool('rewards').availableAtoms,'800');
  k.fundPool({id:'fund2',accountId:1,poolId:'rewards',atoms:'100'});await k.prepareEvent(reward);assert.equal(k.pool('rewards').availableAtoms,'0');await k.advanceEvent(1,'quest1');
  assert.equal(k.character(1,'10').moneyUnits,'35');assert.equal(k.character(2,'20').moneyUnits,'24');
  await assert.rejects(k.prepareEvent({...reward,id:'replayed'}));
 }finally{k.close();}
});
test('staged adapter refuses altered amount and nested RewardQuest without publishing one actor or freeing backing',async()=>{
 const {k,deps}=await fixture();try{
  await k.prepareEvent(trade());deps.world.mutationChange=expected=>({...expected,deltaUnits:'999'});
  await assert.rejects(k.advanceEvent(1,'trade1'));assert.equal(deps.world.eventCommitCalls,0);assert.equal(deps.world.characters.get('10').moneyUnits,'30');assert.equal(k.balance(2).worldAtoms,'1700');
  deps.world.mutationChange=null;deps.world.nestedMutation=op=>{try{applyPreparedLegs(op,()=>{});}catch{}};
  await assert.rejects(k.advanceEvent(1,'trade1'));assert.equal(deps.world.eventCommitCalls,0);assert.equal(k.event(1,'trade1').state,'reserved');
  deps.world.nestedMutation=null;await k.advanceEvent(1,'trade1');assert.equal(deps.world.eventCommitCalls,1);
 }finally{k.close();}
});
test('auction deposit and bid proceeds release held claims once; only the explicit cut reaches its pool',async()=>{
 const {k}=await fixture();try{
  const makeEscrow=(id,kind,ownerAccountId,beneficiaryAccountId)=>({id,kind,ownerAccountId,beneficiaryAccountId,retainedAccountId:ownerAccountId,expiresAt:0,action:'create'});
  await k.prepareEvent(quote({id:'list',family:'auction-list',participants:[{accountId:1,guid:'10'}],escrows:[makeEscrow('listing-deposit','auction',1,1)],legs:[{id:'deposit',from:character(1,'10'),to:escrow('listing-deposit'),units:'2'}]}));await k.advanceEvent(1,'list');
  await k.prepareEvent(quote({id:'bid',accountId:2,family:'auction-bid',participants:[{accountId:2,guid:'20'}],escrows:[makeEscrow('bid-hold','auction',2,1)],legs:[{id:'hold',from:character(2,'20'),to:escrow('bid-hold'),units:'10'}]}));await k.advanceEvent(2,'bid');
  const settlement=quote({id:'auction-win',family:'auction-settle',participants:[],escrows:[{id:'listing-deposit',action:'settle'},{id:'bid-hold',action:'settle'},makeEscrow('seller-mail','mail',1,1)],legs:[{id:'deposit-return',from:escrow('listing-deposit'),to:escrow('seller-mail'),units:'2'},{id:'bid-proceeds',from:escrow('bid-hold'),to:escrow('seller-mail'),units:'9'},{id:'cut',from:escrow('bid-hold'),to:pool('auction-fees'),units:'1'}]});
  await assert.rejects(k.prepareEvent({...settlement,escrows:settlement.escrows.map(e=>e.id==='seller-mail'?{...e,beneficiaryAccountId:3}:e)}));
  assert.equal(k.escrow(2,'bid-hold').availableAtoms,'1000');
  await k.prepareEvent(settlement);await k.advanceEvent(1,'auction-win');await k.advanceEvent(1,'auction-win');
  assert.equal(k.escrow(1,'seller-mail').availableAtoms,'1100');assert.equal(k.pool('auction-fees').availableAtoms,'100');assert.equal(k.pool('rewards').availableAtoms,'0');assert.equal(k.totals().claimsAtoms,'20000');
  await assert.rejects(k.prepareEvent({...settlement,id:'duplicate-win'}));
 }finally{k.close();}
});

export {fixture,trade};
