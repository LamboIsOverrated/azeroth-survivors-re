import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccounting} from '../kernel.mjs';
import {configuration,hash} from '../amounts.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';
import {eventWorld,character,escrow,pool,quote} from './event-fixtures.mjs';
import {NOW} from '../../../economy/settlement/tests/fixtures.mjs';

async function fixture(){const config=configuration(input),deps=dependencies(config);eventWorld(deps.world,config);const k=createAccounting({path:':memory:',config,...deps});await deposit(k,deps);await k.prepareWorld({id:'seed',accountId:1,guid:'10',kind:'grant',units:'30'});await k.advanceWorld(1,'seed');return {k,deps};}
const mailCreate=(id='mail1',beneficiaryAccountId=2)=>({id,action:'create',kind:'mail',ownerAccountId:1,beneficiaryAccountId,retainedAccountId:1,expiresAt:NOW+1000});
async function send(k){const plan=quote({id:'send',family:'mail-send',participants:[{accountId:1,guid:'10'}],escrows:[mailCreate()],legs:[{id:'attachment',from:character(1,'10'),to:escrow('mail1'),units:'7'},{id:'postage',from:character(1,'10'),to:pool('postage'),units:'1'}]});await k.prepareEvent(plan);await k.advanceEvent(1,'send');}
test('mail attachment/postage, COD payment and beneficiary checkout move existing claims without issuance',async()=>{
 const {k}=await fixture();try{
  await send(k);assert.equal(k.escrow(2,'mail1').availableAtoms,'700');assert.equal(k.character(1,'10').moneyUnits,'22');assert.equal(k.pool('postage').availableAtoms,'100');
  const take=quote({id:'take',accountId:2,family:'mail-take',participants:[{accountId:2,guid:'20'}],escrows:[{id:'mail1',action:'settle'}],legs:[{id:'take-money',from:escrow('mail1'),to:character(2,'20'),units:'7'}]});await k.prepareEvent(take);await k.advanceEvent(2,'take');
  assert.equal(k.character(2,'20').moneyUnits,'7');assert.equal(k.escrow(1,'mail1').state,'settled');
  await k.prepareEvent(quote({id:'cod',accountId:2,family:'mail-cod',participants:[{accountId:2,guid:'20'}],escrows:[{...mailCreate('cod-pay',1),ownerAccountId:2,retainedAccountId:2}],legs:[{id:'pay-seller',from:character(2,'20'),to:escrow('cod-pay'),units:'3'}]}));await k.advanceEvent(2,'cod');
  assert.equal(k.escrow(1,'cod-pay').availableAtoms,'300');assert.equal(k.totals().claimsAtoms,'10000');
 }finally{k.close();}
});
test('new mail cannot invent a different retained sender and lifecycle family cannot keep a falsely deleted identity open',async()=>{
 const {k}=await fixture();try{
  await assert.rejects(k.prepareEvent(quote({id:'bad-retain',family:'mail-send',participants:[{accountId:1,guid:'10'}],escrows:[{...mailCreate(),retainedAccountId:3}],legs:[{id:'attach',from:character(1,'10'),to:escrow('mail1'),units:'7'}]})));
  await send(k);
  await assert.rejects(k.prepareEvent(quote({id:'bad-delete',family:'escrow-delete',participants:[],escrows:[{id:'mail1',action:'keep'},{id:'recover',action:'create',kind:'recovery',ownerAccountId:1,beneficiaryAccountId:1,retainedAccountId:1,expiresAt:0}],legs:[{id:'retain',from:escrow('mail1'),to:escrow('recover'),units:'7'}]})));
 }finally{k.close();}
});
test('return retains exact claims for the fixed recovery beneficiary and refuses the former recipient',async()=>{
 const {k}=await fixture();try{
  await send(k);const plan=quote({id:'return',family:'mail-return',participants:[],escrows:[{id:'mail1',action:'return'}],legs:[]});
  await k.prepareEvent(plan);await k.advanceEvent(1,'return');assert.equal(k.escrow(1,'mail1').availableAtoms,'700');assert.equal(k.escrow(1,'mail1').beneficiaryAccountId,1);
  await assert.rejects(k.prepareEvent(quote({id:'steal',accountId:2,family:'mail-take',participants:[{accountId:2,guid:'20'}],escrows:[{id:'mail1',action:'settle'}],legs:[{id:'take',from:escrow('mail1'),to:character(2,'20'),units:'7'}]})));
  await k.prepareEvent(quote({id:'retained',family:'mail-take',participants:[{accountId:1,guid:'10'}],escrows:[{id:'mail1',action:'settle'}],legs:[{id:'take',from:escrow('mail1'),to:character(1,'10'),units:'7'}]}));await k.advanceEvent(1,'retained');assert.equal(k.character(1,'10').moneyUnits,'29');
 }finally{k.close();}
});
test('expiry uses trusted deadline and deletion relocates every atom to a durable recovery owner',async()=>{
 const config=configuration(input),deps=dependencies(config);let now=NOW;deps.clock=()=>now;eventWorld(deps.world,config);const k=createAccounting({path:':memory:',config,...deps});
 try{
  await deposit(k,deps);await k.prepareWorld({id:'seed',accountId:1,guid:'10',kind:'grant',units:'30'});await k.advanceWorld(1,'seed');await send(k);
  const expiry=quote({id:'expiry',family:'mail-expire',participants:[],escrows:[{id:'mail1',action:'expire'}],legs:[]});await assert.rejects(k.prepareEvent(expiry));now+=1001;await k.prepareEvent(expiry);await k.advanceEvent(1,'expiry');
  assert.equal(k.escrow(1,'mail1').state,'expired');assert.equal(k.escrow(1,'mail1').availableAtoms,'700');
  const remove=quote({id:'delete',family:'escrow-delete',participants:[],escrows:[{id:'mail1',action:'delete'},{id:'recovery1',action:'create',kind:'recovery',ownerAccountId:1,beneficiaryAccountId:1,retainedAccountId:1,expiresAt:0}],legs:[{id:'retain',from:escrow('mail1'),to:escrow('recovery1'),units:'7'}]});
  await assert.rejects(k.prepareEvent({...remove,legs:[{...remove.legs[0],units:'6'}]}));await k.prepareEvent(remove);await k.advanceEvent(1,'delete');
  assert.equal(k.escrow(1,'mail1').state,'deleted');assert.equal(k.escrow(1,'recovery1').availableAtoms,'700');
  await assert.rejects(k.prepareEvent(quote({id:'recreate',family:'mail-send',participants:[{accountId:1,guid:'10'}],escrows:[mailCreate()],legs:[{id:'reuse',from:character(1,'10'),to:escrow('mail1'),units:'1'}]})));
  assert.equal(k.totals().claimsAtoms,'10000');
 }finally{k.close();}
});
test('character deletion conserves all world claims in recovery and permanently retires the identity',async()=>{
 const {k}=await fixture();try{
  const plan=quote({id:'retire',family:'character-delete',participants:[{accountId:1,guid:'10',action:'retire'}],escrows:[{id:'char-recovery',action:'create',kind:'recovery',ownerAccountId:1,beneficiaryAccountId:1,retainedAccountId:1,expiresAt:0}],legs:[{id:'retain-character',from:character(1,'10'),to:escrow('char-recovery'),units:'30'}]});await k.prepareEvent(plan);await k.advanceEvent(1,'retire');
  assert.equal(k.escrow(1,'char-recovery').availableAtoms,'3000');await assert.rejects(k.prepareWorld({id:'reuse',accountId:1,guid:'10',kind:'grant',units:'1'}));
 }finally{k.close();}
});
