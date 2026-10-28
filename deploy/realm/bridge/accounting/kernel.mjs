import {AccountingStore} from './store.mjs';
import {deposits} from './deposit.mjs';
import {events} from './events.mjs';
import {withdrawals} from './withdrawals.mjs';
import {configuration,account,identifier,units,atoms,positive,gameAtoms,canonical,hash,GAME_MAX} from './amounts.mjs';

const reasons=new Set(['quest','loot','vendor-sale','starting-money']);
const rejected=new Set(['policy-rejection','stale-version','missing-character','owner-mismatch','overflow','insufficient-money']);
function guid(value){if(typeof value!=='string'||! /^[1-9][0-9]{0,9}$/.test(value)||BigInt(value)>4294967295n)throw Error('Canonical character guid required');return value;}
function request(input){
 const result={id:identifier(input.id),accountId:account(input.accountId),guid:guid(input.guid),kind:input.kind,units:units(input.units).toString()};
 if(result.units==='0'||!['grant','redeem','issue','sink'].includes(result.kind))throw Error('Typed positive world operation required');
 if(['issue','sink'].includes(result.kind))result.poolId=identifier(input.poolId);
 else if(input.poolId!==undefined)throw Error('Unexpected pool');
 if(result.kind==='issue'){result.eventId=identifier(input.eventId);if(!reasons.has(input.reason))throw Error('Authoritative issuance reason required');result.reason=input.reason;}
 else if(input.eventId!==undefined||input.reason!==undefined)throw Error('Unexpected issuance event');
 return result;
}
export function createAccounting({path,config,rpc,archiveRpc,signer,resolveWallet,world,clock=Date.now}){
 const cfg=configuration(config),store=new AccountingStore(path,cfg),proofs=deposits({store,rpc,resolveWallet,clock});
 const get=id=>store.db.prepare('SELECT * FROM ac_operations WHERE id=?').get(id);
 function owned(accountId,id){account(accountId);identifier(id);const row=get(id);if(!row||row.account_id!==accountId||JSON.parse(row.payload).format!==undefined)throw Error('Single-character account operation required');return row;}
 function operation(accountId,id){const row=owned(accountId,id);return {...JSON.parse(row.payload),state:row.state};}
 function matchDomain(value){if(!value||value.phase!=='LIVE'||value.namespaceId!==cfg.namespaceId||value.configHash!==cfg.hash)throw Error('LIVE namespace proof required');}
 function snapshot(value,req){
  matchDomain(value);if(value.accountId!==req.accountId||value.guid!==req.guid)throw Error('Character ownership mismatch');
  units(value.moneyUnits);atoms(value.version);return {moneyUnits:value.moneyUnits,version:value.version};
 }
 function source(op){
  const r=op.request;return r.kind==='grant'?['vault_available','account:'+r.accountId,'vault_reserved']:r.kind==='issue'?['pool_available','pool:'+r.poolId,'pool_reserved']:['world_allocated','character:'+r.guid,'world_escrow'];
 }
 function destination(op){const r=op.request;return ['grant','issue'].includes(r.kind)?['world_allocated','character:'+r.guid]:r.kind==='redeem'?['vault_available','account:'+r.accountId]:['pool_available','pool:'+r.poolId];}
 function acceptReceipt(op,proof){
  matchDomain(proof);identifier(proof.id);const r=op.request;
  if(proof.operationId!==op.id||proof.accountId!==r.accountId||proof.guid!==r.guid||proof.kind!==r.kind||proof.units!==r.units||proof.beforeUnits!==op.expected.moneyUnits||proof.beforeVersion!==op.expected.version)throw Error('World receipt binding mismatch');
  units(proof.afterUnits);atoms(proof.afterVersion);
  if(proof.outcome==='applied'){
   if(proof.reason!=='applied'||proof.afterUnits!==op.afterUnits||proof.afterVersion!==(BigInt(op.expected.version)+1n).toString())throw Error('Applied world receipt mismatch');
  }else if(proof.outcome==='rejected'){
   if(!rejected.has(proof.reason)||proof.afterUnits!==op.expected.moneyUnits||proof.afterVersion!==op.expected.version)throw Error('No-change rejection proof required');
  }else throw Error('Indeterminate receipt keeps reservation');
 }
 return Object.freeze({
  ...events({store,world,clock}),
  ...withdrawals({store,rpc,archiveRpc,signer,resolveWallet,clock}),
  config:cfg,
  createDeposit:input=>proofs.create(input),confirmDeposit:input=>proofs.confirm(input),
  totals:()=>store.totals(),
  balance(accountId){account(accountId);let worldAtoms=0n;for(const c of store.db.prepare('SELECT guid FROM ac_characters WHERE account_id=?').all(accountId))worldAtoms+=BigInt(store.balance('world_allocated','character:'+c.guid));return {vaultAtoms:store.balance('vault_available','account:'+accountId),worldAtoms:worldAtoms.toString()};},
  character(accountId,value){account(accountId);guid(value);const row=store.db.prepare('SELECT * FROM ac_characters WHERE guid=?').get(value);if(!row||row.account_id!==accountId)throw Error('Owned tracked character required');return {guid:value,moneyUnits:row.units,version:row.version};},
  pool(poolId){identifier(poolId);return {availableAtoms:store.balance('pool_available','pool:'+poolId)};},
  operation,
  fundPool(input){
   const payload={id:identifier(input.id),accountId:account(input.accountId),poolId:identifier(input.poolId),atoms:positive(input.atoms).toString()};
   return store.atomic(()=>store.post({key:'fund:'+payload.id,kind:'pool-funding',payload,postings:[{bucket:'vault_available',owner:'account:'+payload.accountId,delta:-atoms(payload.atoms)},{bucket:'pool_available',owner:'pool:'+payload.poolId,delta:atoms(payload.atoms)}]}));
  },
  async prepareWorld(input){
   const req=request(input),prior=get(req.id);
   if(prior){if(prior.account_id!==req.accountId||canonical(JSON.parse(prior.payload).request)!==canonical(req))throw Error('World idempotency conflict');return operation(req.accountId,req.id);}
   if(typeof world?.authorizeCharacter!=='function')throw Error('LIVE world adapter unavailable');
   const expected=snapshot(await world.authorizeCharacter({phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,...req}),req);
   const direction=['grant','issue'].includes(req.kind)?1n:-1n,after=units(expected.moneyUnits)+direction*units(req.units);
   if(after<0n||after>GAME_MAX||BigInt(expected.version)===18446744073709551615n)throw Error('World money/version bounds');
   const op={phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,id:req.id,request:req,expected,afterUnits:after.toString(),atoms:gameAtoms(req.units,cfg)};
   return store.atomic(()=>{
    const race=get(req.id);if(race){if(race.account_id!==req.accountId||canonical(JSON.parse(race.payload).request)!==canonical(req))throw Error('World idempotency conflict');return operation(req.accountId,req.id);}
    if(store.db.prepare('SELECT guid FROM ac_retired WHERE guid=?').get(req.guid))throw Error('Retired character identity');
    const character=store.db.prepare('SELECT * FROM ac_characters WHERE guid=?').get(req.guid);
    if(character){if(character.account_id!==req.accountId||character.units!==expected.moneyUnits||character.version!==expected.version||store.balance('world_allocated','character:'+req.guid)!==gameAtoms(expected.moneyUnits,cfg))throw Error('Unbacked/stale character snapshot');}
    else{if(expected.moneyUnits!=='0')throw Error('Unbacked stock character money refused');store.db.prepare('INSERT INTO ac_characters VALUES(?,?,?,?)').run(req.guid,req.accountId,'0',expected.version);}
    store.db.prepare('INSERT INTO ac_operations VALUES(?,?,?,?,NULL)').run(req.id,req.accountId,canonical(op),'reserved');
    store.db.prepare('INSERT INTO ac_locks VALUES(?,?)').run(req.guid,req.id);
    store.db.prepare('INSERT INTO ac_locks VALUES(?,?)').run('account:'+req.accountId,req.id);
    if(req.kind==='issue')store.db.prepare('INSERT INTO ac_events VALUES(?,?)').run(req.eventId,req.id);
    const [bucket,owner,hold]=source(op),amount=atoms(op.atoms);
    store.post({key:'reserve:'+req.id,kind:'world-reserve',payload:op,postings:[{bucket,owner,delta:-amount},{bucket:hold,owner:'operation:'+req.id,delta:amount}]});
    return operation(req.accountId,req.id);
   });
  },
  async advanceWorld(accountId,id){
   let row=owned(accountId,id),op=JSON.parse(row.payload);if(row.state==='complete')return operation(accountId,id);
   if(row.state==='reserved'){
    if(typeof world?.readReceipt!=='function'||typeof world?.apply!=='function')throw Error('LIVE world receipt adapter unavailable');
    // A null lookup is not a refund. apply must be idempotent and compare-and-swap expected balance/version under its durable fence.
    const proof=await world.readReceipt(structuredClone(op))??await world.apply(structuredClone(op));acceptReceipt(op,proof);
    store.atomic(()=>{
     const current=owned(accountId,id);if(current.state!=='reserved'){if(current.receipt!==canonical(proof))throw Error('World receipt conflict');return;}
     store.db.prepare('INSERT INTO ac_receipts VALUES(?,?,?)').run(proof.id,id,canonical(proof));
     const [bucket,owner,hold]=source(op),[target,targetOwner]=proof.outcome==='applied'?destination(op):[bucket,owner],amount=atoms(op.atoms);
     store.post({key:'settle:'+id,kind:'world-'+proof.outcome,payload:proof,postings:[{bucket:hold,owner:'operation:'+id,delta:-amount},{bucket:target,owner:targetOwner,delta:amount}]});
     store.db.prepare('UPDATE ac_characters SET units=?,version=? WHERE guid=? AND account_id=?').run(proof.afterUnits,proof.afterVersion,op.request.guid,accountId);
     store.db.prepare("UPDATE ac_operations SET state='awaiting_ack',receipt=? WHERE id=?").run(canonical(proof),id);
    });
   }
   row=owned(accountId,id);if(row.state==='complete')return operation(accountId,id);
   const proof=JSON.parse(row.receipt),batchKey='settle:'+id,receiptHash=hash(proof);
   if(typeof world?.ack!=='function')throw Error('Durable world fence acknowledgement unavailable');
   const ack=await world.ack({operation:structuredClone(op),receiptId:proof.id,receiptHash,batchKey});matchDomain(ack);
   if(ack.operationId!==id||ack.receiptId!==proof.id||ack.batchKey!==batchKey||ack.receiptHash!==receiptHash)throw Error('Accounting acknowledgement mismatch');
   store.atomic(()=>{const current=owned(accountId,id);if(current.state==='complete')return;if(current.state!=='awaiting_ack'||current.receipt!==canonical(proof))throw Error('Accounting acknowledgement conflict');store.db.prepare("UPDATE ac_operations SET state='complete' WHERE id=?").run(id);store.db.prepare('DELETE FROM ac_locks WHERE operation_id=?').run(id);});
   return operation(accountId,id);
  },
  close:()=>store.close(),
 });
}
