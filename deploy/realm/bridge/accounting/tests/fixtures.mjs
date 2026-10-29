import {config as chain,fakeRpc,receipt,tokenInfo,pairs,source,treasury,NOW} from '../../../economy/settlement/tests/fixtures.mjs';
import {signatureOf} from '../../../economy/settlement/protocol.mjs';
export const input={...chain,namespaceId:'closed-live-fixture',phase:'LIVE',atomsPerGameUnit:'100'};
export const wallet=pairs[1].publicKey.toBase58();
export function worldFixture(config){
 const world={characters:new Map(),receipts:new Map(),fences:new Map(),applyCalls:0,ackCalls:0,lostApply:false,lostAck:false,reject:false};
 world.character=(accountId=1,guid='10')=>({phase:'LIVE',namespaceId:config.namespaceId,configHash:config.hash,accountId,guid,moneyUnits:'0',version:'0'});
 world.authorizeCharacter=async({accountId,guid})=>{
  if(world.fences.has(guid))throw Error('World fenced');
  return structuredClone(world.characters.get(guid)??world.character(accountId,guid));
 };
 world.readReceipt=async operation=>structuredClone(world.receipts.get(operation.id)??null);
 world.apply=async operation=>{
  world.applyCalls++;if(world.receipts.has(operation.id))return world.readReceipt(operation);
  const {request,expected}=operation;
  if(world.fences.has(request.guid))throw Error('World fenced');
  const current=world.characters.get(request.guid)??world.character(request.accountId,request.guid);
  if(current.version!==expected.version||current.moneyUnits!==expected.moneyUnits)throw Error('World CAS mismatch');
  world.fences.set(request.guid,operation.id);
  const applied=!world.reject,after=applied?operation.afterUnits:current.moneyUnits,next=applied?(BigInt(current.version)+1n).toString():current.version;
  const proof={phase:'LIVE',namespaceId:config.namespaceId,configHash:config.hash,id:'receipt:'+operation.id,operationId:operation.id,accountId:request.accountId,guid:request.guid,kind:request.kind,units:request.units,beforeUnits:current.moneyUnits,afterUnits:after,beforeVersion:current.version,afterVersion:next,outcome:applied?'applied':'rejected',reason:applied?'applied':'policy-rejection'};
  world.characters.set(request.guid,{...current,moneyUnits:after,version:next});world.receipts.set(operation.id,proof);
  if(world.lostApply)throw Error('Lost apply acknowledgement');return structuredClone(proof);
 };
 world.ack=async({operation,receiptId,receiptHash,batchKey})=>{
  world.ackCalls++;const proof=world.receipts.get(operation.id);
  if(!proof||receiptId!==proof.id||!batchKey)throw Error('Bad durable accounting ack');
  world.fences.delete(operation.request.guid);
  if(world.lostAck)throw Error('Lost accounting acknowledgement');
  return {phase:'LIVE',namespaceId:config.namespaceId,configHash:config.hash,operationId:operation.id,receiptId,receiptHash,batchKey};
 };
 return world;
}
export function dependencies(config){return {rpc:fakeRpc(),world:worldFixture(config),resolveWallet:async()=>wallet,clock:()=>NOW};}
export async function deposit(kernel,deps,{id='deposit1',accountId=1,amount='10000'}={}){
 const intent=await kernel.createDeposit({accountId,id,atoms:amount,sourceTokenAccount:source});
 const {row,tx}=receipt(intent),signature=signatureOf(tx);
 deps.rpc.receipts.set(signature,row);deps.rpc.statuses.set(signature,{err:null,confirmationStatus:'finalized',slot:row.slot});
 deps.rpc.tokens.set(treasury,tokenInfo(chain.treasuryWallet,'18446744073709551615'));
 await kernel.confirmDeposit({accountId,id,signature});return {intent,signature,row};
}
