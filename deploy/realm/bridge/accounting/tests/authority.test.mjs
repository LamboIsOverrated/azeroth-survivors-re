import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPreparedLegs} from '../authority.mjs';
import {hash} from '../amounts.mjs';
const request={id:'quest-op',eventId:'quest1'},binding={namespaceId:'closed-live',configHash:hash('config'),operationId:'quest-op',requestHash:hash(request),ownerVersion:'1'};
const mutations=[{...binding,eventId:'quest1',legId:'xp-money',side:'credit',owner:{type:'character',accountId:1,guid:'10'},deltaUnits:'3',beforeUnits:'0',afterUnits:'3'},{...binding,eventId:'quest1',legId:'reward-money',side:'credit',owner:{type:'character',accountId:1,guid:'10'},deltaUnits:'2',beforeUnits:'3',afterUnits:'5'}];
const operation={format:'atomic-event-v1',phase:'LIVE',namespaceId:binding.namespaceId,configHash:binding.configHash,id:'quest-op',requestHash:hash(request),request,mutations};
test('exact one-shot leg authority consumes distinct quest sites and binds event/owner/amount/before/after',()=>{
 const applied=[];const result=applyPreparedLegs(operation,(expected,ticket)=>ticket.apply(expected,()=>applied.push(expected.deltaUnits)));
 assert.deepEqual(applied,['3','2']);assert.deepEqual(result,mutations);
 for(const change of [{deltaUnits:'4'},{eventId:'other'},{legId:'nested-quest'},{owner:{type:'character',accountId:2,guid:'20'}},{afterUnits:'99'},{namespaceId:'TEST'},{configHash:hash('foreign')},{ownerVersion:'2'}]){
  let calls=0;assert.throws(()=>applyPreparedLegs(operation,(expected,ticket)=>ticket.apply({...expected,...change},()=>calls++)));assert.equal(calls,0);
 }
});
test('MoneyChanged reentry cannot reuse, inherit or create a second event authority while a sink is active',()=>{
 let outerCalls=0,nestedCalls=0;
 assert.throws(()=>applyPreparedLegs(operation,(expected,ticket)=>ticket.apply(expected,()=>{
  outerCalls++;applyPreparedLegs({...operation,request:{eventId:'nested-event'},mutations:mutations.map(m=>({...m,eventId:'nested-event'}))},(n,t)=>t.apply(n,()=>nestedCalls++));
 })));
 assert.equal(outerCalls,1);assert.equal(nestedCalls,0);
 let saved;
 assert.throws(()=>applyPreparedLegs(operation,(expected,ticket)=>{saved=ticket;ticket.apply(expected,()=>{});ticket.apply(expected,()=>nestedCalls++);}));
 assert.throws(()=>saved.apply(mutations[0],()=>nestedCalls++));assert.equal(nestedCalls,0);
});
test('skipped legs, asynchronous callbacks and retained tickets abort instead of authorizing a partial gameplay commit',()=>{
 let saved;
 assert.throws(()=>applyPreparedLegs(operation,(_expected,ticket)=>{saved=ticket;}));
 assert.throws(()=>saved.apply(mutations[0],()=>{}));
 assert.throws(()=>applyPreparedLegs(operation,(expected,ticket)=>ticket.apply(expected,()=>Promise.resolve())));
 assert.throws(()=>applyPreparedLegs(operation,async(expected,ticket)=>ticket.apply(expected,()=>{})));
 assert.throws(()=>applyPreparedLegs({...operation,mutations:[mutations[0],mutations[0]]},()=>{}));
});
test('catching a rejected nested authority still poisons the entire staged event',()=>{
 assert.throws(()=>applyPreparedLegs(operation,(expected,ticket)=>ticket.apply(expected,()=>{
  try{applyPreparedLegs(operation,()=>{});}catch{}
 })));
});
test('explicit async executors and money sinks are rejected before their bodies run',()=>{
 let calls=0;
 assert.throws(()=>applyPreparedLegs(operation,async()=>{calls++;}));assert.equal(calls,0);
 assert.throws(()=>applyPreparedLegs(operation,(expected,ticket)=>ticket.apply(expected,async()=>{calls++;})));assert.equal(calls,0);
});
test('an expired event A ticket poisons the current event B even when B catches its rejection',()=>{
 let expired,oldMutation,invalidCalls=0,newCalls=0;
 applyPreparedLegs(operation,(expected,ticket)=>{expired=ticket;oldMutation=expected;ticket.apply(expected,()=>{});});
 const nextRequest={id:'event-b',eventId:'event-b'},next={...operation,id:'event-b',request:nextRequest,requestHash:hash(nextRequest),mutations:mutations.map(m=>({...m,operationId:'event-b',eventId:'event-b',requestHash:hash(nextRequest)}))};
 assert.throws(()=>applyPreparedLegs(next,(expected,ticket)=>ticket.apply(expected,()=>{
  newCalls++;try{expired.apply(oldMutation,()=>invalidCalls++);}catch{}
 })));
 assert.equal(invalidCalls,0);assert.equal(newCalls,1);
 newCalls=0;
 assert.throws(()=>applyPreparedLegs(next,(expected,ticket)=>{
  try{expired.apply(oldMutation,()=>invalidCalls++);}catch{}
  ticket.apply(expected,()=>newCalls++);
 }));
 assert.equal(newCalls,0);
});
