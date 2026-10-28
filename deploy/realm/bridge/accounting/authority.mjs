import {canonical,identifier,units,atoms,hash} from './amounts.mjs';
import {owner,ownerKey,digest} from './event-plan.mjs';
import {types} from 'node:util';

let active=null;
function synchronous(result){if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw Error('Asynchronous money/event application forbidden');}return result;}

// Synchronous trusted-adapter primitive. The adapter must roll back its complete
// staged gameplay transaction on ANY error; this helper cannot undo gameplay.
// It is deliberately not a general ambient permission to call a money setter.
export function applyPreparedLegs(operation,executor){
 if(active){active.poisoned=true;throw Error('Nested/reentrant event authority forbidden');}
 if(operation?.format!=='atomic-event-v1'||!Array.isArray(operation.mutations)||operation.mutations.length>64||typeof executor!=='function'||types.isAsyncFunction(executor))throw Error('Prepared exact synchronous event mutations required');
 if(operation.phase!=='LIVE'||identifier(operation.namespaceId)!==operation.namespaceId||digest(operation.configHash)!==operation.configHash||identifier(operation.id)!==operation.request.id||hash(operation.request)!==operation.requestHash)throw Error('Bound LIVE event authority required');
 const eventId=identifier(operation.request.eventId),seen=new Set();
 const mutations=operation.mutations.map(value=>{
  const endpoint=owner(value.owner);if(endpoint.type==='pool'||value.eventId!==eventId||!['debit','credit'].includes(value.side))throw Error('Exact world money mutation required');
  identifier(value.legId);units(value.beforeUnits);units(value.afterUnits);atoms(value.ownerVersion);
  if(value.namespaceId!==operation.namespaceId||value.configHash!==operation.configHash||value.operationId!==operation.id||value.requestHash!==operation.requestHash)throw Error('Mutation belongs to another event/namespace');
  const delta=BigInt(value.afterUnits)-BigInt(value.beforeUnits);
  if(typeof value.deltaUnits!=='string'||value.deltaUnits!==delta.toString()||delta===0n||delta<0n!==(value.side==='debit'))throw Error('Exact signed mutation delta required');
  const clean={namespaceId:operation.namespaceId,configHash:operation.configHash,operationId:operation.id,requestHash:operation.requestHash,ownerVersion:value.ownerVersion,eventId,legId:value.legId,side:value.side,owner:endpoint,deltaUnits:value.deltaUnits,beforeUnits:value.beforeUnits,afterUnits:value.afterUnits};
  if(canonical(clean)!==canonical(value))throw Error('Unknown mutation authority field');
  const key=value.legId+'|'+value.side+'|'+ownerKey(endpoint);if(seen.has(key))throw Error('Duplicate mutation authority');seen.add(key);return clean;
 });
 let poisoned=false;const consumed=[],context={poisoned:false};active=context;
 try{
  for(const expected of mutations){
   let alive=true,used=false;const expectedText=canonical(expected);
   const ticket=Object.freeze({apply(actual,mutate){
    if(!alive||used){poisoned=true;throw Error('Consumed/expired exact mutation ticket');}
    used=true;
    try{
     if(canonical(actual)!==expectedText||typeof mutate!=='function'||types.isAsyncFunction(mutate))throw Error('Mutation exceeds exact synchronous leg authority');
     const result=synchronous(mutate());
     consumed.push(structuredClone(expected));return result;
    }catch(error){poisoned=true;throw error;}
   }});
   try{synchronous(executor(structuredClone(expected),ticket));if(!used)throw Error('Prepared mutation omitted');if(poisoned||context.poisoned)throw Error('Poisoned event must roll back');}
   catch(error){poisoned=true;throw error;}
   finally{alive=false;}
  }
  if(poisoned||context.poisoned||consumed.length!==mutations.length)throw Error('Partial/failed money event must roll back');
  return consumed;
 }finally{active=null;}
}
