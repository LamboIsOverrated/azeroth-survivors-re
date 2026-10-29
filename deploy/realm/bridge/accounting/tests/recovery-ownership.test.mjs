import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccounting} from '../kernel.mjs';
import {configuration} from '../amounts.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';
import {eventWorld,character,escrow,quote} from './event-fixtures.mjs';
import {NOW} from '../../../economy/settlement/tests/fixtures.mjs';
import {escrowState} from '../event-plan.mjs';

const createRecovery=(id,ownerAccountId=1,beneficiaryAccountId=1,retainedAccountId=1)=>({id,action:'create',kind:'recovery',ownerAccountId,beneficiaryAccountId,retainedAccountId,expiresAt:0});
async function fixture(){
 const config=configuration(input),deps=dependencies(config);let now=NOW;deps.clock=()=>now;eventWorld(deps.world,config);
 const k=createAccounting({path:':memory:',config,...deps});await deposit(k,deps);await k.prepareWorld({id:'seed',accountId:1,guid:'10',kind:'grant',units:'30'});await k.advanceWorld(1,'seed');
 await k.prepareEvent(quote({id:'send',family:'mail-send',participants:[{accountId:1,guid:'10'}],escrows:[{id:'mail',action:'create',kind:'mail',ownerAccountId:1,beneficiaryAccountId:2,retainedAccountId:1,expiresAt:NOW+1000}],legs:[{id:'attachment',from:character(1,'10'),to:escrow('mail'),units:'7'}]}));await k.advanceEvent(1,'send');
 return {k,deps,expire:()=>now=NOW+1001};
}
for(const state of ['open','returned','expired'])for(const family of ['escrow-recover','escrow-delete'])test(state+' '+family+' rejects owner/retained substitution despite a matching current beneficiary',async()=>{
 const {k,expire}=await fixture();try{
  if(state!=='open'){if(state==='expired')expire();const action=state==='returned'?'return':'expire';await k.prepareEvent(quote({id:action,family:'mail-'+action,participants:[],escrows:[{id:'mail',action}],legs:[]}));await k.advanceEvent(1,action);}
  const plan=quote({id:'recover',family,participants:[],escrows:[{id:'mail',action:family==='escrow-delete'?'delete':'keep'},createRecovery('recovery',2,1,2)],legs:[{id:'retain',from:escrow('mail'),to:escrow('recovery'),units:'7'}]});
  await assert.rejects(k.prepareEvent(plan));assert.equal(k.escrow(1,'mail').availableAtoms,'700');assert.equal(k.escrow(1,'mail').retainedAccountId,1);
  // A valid first recovery may be moved/deleted again only under that same account.
  const safe={...plan,escrows:[plan.escrows[0],createRecovery('recovery')]};await k.prepareEvent(safe);await k.advanceEvent(1,'recover');
  const second=quote({id:'second-delete',family:'escrow-delete',participants:[],escrows:[{id:'recovery',action:'delete'},createRecovery('attacker',2,2,2)],legs:[{id:'retain-again',from:escrow('recovery'),to:escrow('attacker'),units:'7'}]});await assert.rejects(k.prepareEvent(second));
  await k.prepareEvent({...second,escrows:[second.escrows[0],createRecovery('attacker')]});await k.advanceEvent(1,'second-delete');
  await k.prepareEvent(quote({id:'claim',family:'escrow-claim',participants:[{accountId:1,guid:'10'}],escrows:[{id:'attacker',action:'settle'}],legs:[{id:'claim',from:escrow('attacker'),to:character(1,'10'),units:'7'}]}));await k.advanceEvent(1,'claim');
  assert.equal(k.character(1,'10').moneyUnits,'30');assert.equal(k.totals().claimsAtoms,'10000');
 }finally{k.close();}
});
test('character retirement requires recovery owner, beneficiary and retained account all match its original account',async()=>{
 const {k}=await fixture();try{
  const request=quote({id:'retire',family:'character-delete',participants:[{accountId:1,guid:'10',action:'retire'}],escrows:[createRecovery('recovery',2,1,2)],legs:[{id:'retain',from:character(1,'10'),to:escrow('recovery'),units:'23'}]});await assert.rejects(k.prepareEvent(request));assert.equal(k.character(1,'10').moneyUnits,'23');
 }finally{k.close();}
});
test('existing recovery and returned/expired snapshots cannot carry a different beneficiary or retained account',()=>{
 const base={id:'legacy',kind:'recovery',ownerAccountId:1,beneficiaryAccountId:1,retainedAccountId:1,expiresAt:0,state:'open',moneyUnits:'7',version:'1'};
 for(const change of [{ownerAccountId:2,retainedAccountId:2},{beneficiaryAccountId:2},{retainedAccountId:2},{kind:'mail',state:'returned',beneficiaryAccountId:2},{kind:'mail',state:'expired',beneficiaryAccountId:2}])assert.throws(()=>escrowState({...base,...change}));
 assert.equal(escrowState(base).retainedAccountId,1);
});
test('automated auction refund mail retains its predetermined bidder through expiry instead of an injected sender',async()=>{
 const {k,deps,expire}=await fixture();try{
  await deposit(k,deps,{accountId:2,id:'dep2'});
  await k.prepareWorld({id:'seed2',accountId:2,guid:'20',kind:'grant',units:'20'});await k.advanceWorld(2,'seed2');
  const bid=quote({id:'bid',accountId:2,family:'auction-bid',participants:[{accountId:2,guid:'20'}],escrows:[{id:'bid',action:'create',kind:'auction',ownerAccountId:2,beneficiaryAccountId:1,retainedAccountId:2,expiresAt:0}],legs:[{id:'bid',from:character(2,'20'),to:escrow('bid'),units:'7'}]});await k.prepareEvent(bid);await k.advanceEvent(2,'bid');
  const refund=quote({id:'refund',family:'auction-cancel',participants:[],escrows:[{id:'bid',action:'settle'},{id:'refund-mail',action:'create',kind:'mail',ownerAccountId:1,beneficiaryAccountId:2,retainedAccountId:1,expiresAt:NOW+1000}],legs:[{id:'refund',from:escrow('bid'),to:escrow('refund-mail'),units:'7'}]});await assert.rejects(k.prepareEvent(refund));
  await k.prepareEvent({...refund,escrows:[refund.escrows[0],{...refund.escrows[1],ownerAccountId:2,retainedAccountId:2}]});await k.advanceEvent(1,'refund');expire();
  await k.prepareEvent(quote({id:'refund-expired',family:'mail-expire',participants:[],escrows:[{id:'refund-mail',action:'expire'}],legs:[]}));await k.advanceEvent(1,'refund-expired');assert.equal(k.escrow(2,'refund-mail').beneficiaryAccountId,2);assert.equal(k.escrow(2,'refund-mail').availableAtoms,'700');
 }finally{k.close();}
});
