import {hash} from '../amounts.mjs';
import {applyPreparedLegs} from '../authority.mjs';
export const character=(accountId,guid)=>({type:'character',accountId,guid});
export const escrow=id=>({type:'escrow',id});
export const pool=id=>({type:'pool',id});
export function quote(value){return {accountId:1,eventId:value.id,planDigest:hash('gameplay:'+value.id),escrows:[],...value,participants:value.participants.map(p=>({...p,afterStateHash:hash('result:'+value.id+':'+p.guid)}))};}
export function eventWorld(world,config){
 world.eventReceipts=new Map();world.escrows=new Map();world.eventFences=new Map();world.eventApplyCalls=0;world.eventCommitCalls=0;world.eventAckCalls=0;
 world.authorizeEvent=async request=>({phase:'LIVE',namespaceId:config.namespaceId,configHash:config.hash,requestHash:hash(request),participants:request.participants.map(p=>({...structuredClone(world.characters.get(p.guid)??world.character(p.accountId,p.guid)),gameplayStateHash:hash('state:'+(world.characters.get(p.guid)?.version??'0'))})),escrows:request.escrows.map(a=>structuredClone(world.escrows.get(a.id)??{id:a.id,absent:true}))});
 world.readEventReceipt=async op=>structuredClone(world.eventReceipts.get(op.id)??null);
 world.applyEvent=async op=>{
  world.eventApplyCalls++;
  if(world.eventReceipts.has(op.id))return world.readEventReceipt(op);
  for(const p of op.expected.participants){const current=world.characters.get(p.guid)??world.character(p.accountId,p.guid);if(current.moneyUnits!==p.moneyUnits||current.version!==p.version)throw Error('World event CAS mismatch');}
  world.eventFences.set(op.id,true);
  const applied=!world.eventReject,after=applied?op.after:op.expected;
  const consumed=applied?applyPreparedLegs(op,(expected,ticket)=>ticket.apply(world.mutationChange?world.mutationChange(expected):expected,()=>{if(world.nestedMutation)world.nestedMutation(op);})):[];
  const proof={phase:'LIVE',namespaceId:config.namespaceId,configHash:config.hash,id:'event-receipt:'+op.id,operationId:op.id,accountId:op.request.accountId,eventId:op.request.eventId,requestHash:op.requestHash,planDigest:op.request.planDigest,outcome:applied?'applied':'rejected',reason:applied?'applied':'policy-rejection',legs:op.request.legs,participants:structuredClone(after.participants),escrows:structuredClone(after.escrows),consumed};
  world.eventCommitCalls++;
  if(applied){for(const p of after.participants)world.characters.set(p.guid,structuredClone(p));for(const e of after.escrows)world.escrows.set(e.id,structuredClone(e));}
  world.eventReceipts.set(op.id,proof);if(world.eventLostApply)throw Error('Lost event apply reply');return structuredClone(proof);
 };
 world.ackEvent=async({operation,receiptId,receiptHash,batchKey})=>{
  world.eventAckCalls++;if(!world.eventReceipts.has(operation.id))throw Error('No durable event');world.eventFences.delete(operation.id);
  if(world.eventLostAck)throw Error('Lost event accounting acknowledgement');
  return {phase:'LIVE',namespaceId:config.namespaceId,configHash:config.hash,operationId:operation.id,receiptId,receiptHash,batchKey};
 };
 return world;
}
