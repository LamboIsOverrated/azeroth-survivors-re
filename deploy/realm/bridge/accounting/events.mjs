import {account,identifier,canonical,hash,gameAtoms,atoms} from './amounts.mjs';
import {eventRequest,compileEvent,domain,ownerKey,bucket,escrowState} from './event-plan.mjs';

const rejected=new Set(['policy-rejection','stale-version','missing-character','owner-mismatch','overflow','insufficient-money','missing-escrow','gameplay-conflict']);
export function events({store,world,clock}){
 const cfg=store.config;
 const get=id=>store.db.prepare('SELECT * FROM ac_operations WHERE id=?').get(id);
 function owned(accountId,id){account(accountId);identifier(id);const row=get(id);if(!row||row.account_id!==accountId||JSON.parse(row.payload).format!=='atomic-event-v1')throw Error('Owned atomic event required');return row;}
 function event(accountId,id){const row=owned(accountId,id);return {...JSON.parse(row.payload),state:row.state};}
 function duplicate(row,req){if(row.account_id!==req.accountId||JSON.parse(row.payload).format!=='atomic-event-v1'||canonical(JSON.parse(row.payload).request)!==canonical(req))throw Error('Atomic event idempotency conflict');return event(req.accountId,req.id);}
 function reservePostings(op){const result=op.sources.map(s=>({bucket:bucket(s.owner),owner:ownerKey(s.owner),delta:-atoms(s.atoms)})),sum=op.sources.reduce((n,s)=>n+atoms(s.atoms),0n);if(sum)result.push({bucket:'event_reserved',owner:'operation:'+op.id,delta:sum});return result;}
 function settlementPostings(op,applied){const destinations=applied?op.targets:op.sources,sum=op.sources.reduce((n,s)=>n+atoms(s.atoms),0n);return [...(sum?[{bucket:'event_reserved',owner:'operation:'+op.id,delta:-sum}]:[]),...destinations.map(s=>({bucket:bucket(s.owner),owner:ownerKey(s.owner),delta:atoms(s.atoms)}))];}
 function receipt(op,value){
  domain(value,cfg);identifier(value.id);
  if(value.operationId!==op.id||value.accountId!==op.request.accountId||value.eventId!==op.request.eventId||value.requestHash!==op.requestHash||value.planDigest!==op.request.planDigest||canonical(value.legs)!==canonical(op.request.legs))throw Error('Atomic receipt/event binding mismatch');
  const applied=value.outcome==='applied';
  if(!applied&&!(value.outcome==='rejected'&&rejected.has(value.reason))||applied&&value.reason!=='applied')throw Error('Checked complete event outcome required');
  const expected=applied?op.after:op.expected;
  if(canonical(value.participants)!==canonical(expected.participants)||canonical(value.escrows)!==canonical(expected.escrows)||canonical(value.consumed)!==canonical(applied?op.mutations:[]))throw Error('Complete exact participant/escrow/leg receipt required');
 }
 return {
  event,
  escrow(accountId,id){account(accountId);identifier(id);const row=store.db.prepare('SELECT payload FROM ac_escrows WHERE id=?').get(id);if(!row)throw Error('Tracked escrow required');const value=JSON.parse(row.payload);if(![value.ownerAccountId,value.beneficiaryAccountId,value.retainedAccountId].includes(accountId))throw Error('Owned escrow required');return {...value,availableAtoms:store.balance('escrow_available','escrow:'+id)};},
  async prepareEvent(input){
   const req=eventRequest(input),prior=get(req.id);if(prior)return duplicate(prior,req);
   if(typeof world?.authorizeEvent!=='function')throw Error('Atomic LIVE world adapter unavailable');
   const proof=await world.authorizeEvent(structuredClone(req)),compiled=compileEvent(req,proof,cfg,clock());
   const op={format:'atomic-event-v1',phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,id:req.id,request:req,requestHash:hash(req),...compiled,sources:compiled.sources.map(s=>({...s,atoms:s.atoms.toString()})),targets:compiled.targets.map(s=>({...s,atoms:s.atoms.toString()}))};
   return store.atomic(()=>{
    const race=get(req.id);if(race)return duplicate(race,req);
    for(const p of op.expected.participants){
     if(store.db.prepare('SELECT guid FROM ac_retired WHERE guid=?').get(p.guid))throw Error('Retired character identity');
     const old=store.db.prepare('SELECT * FROM ac_characters WHERE guid=?').get(p.guid);
     if(old){if(old.account_id!==p.accountId||old.units!==p.moneyUnits||old.version!==p.version||store.balance('world_allocated','character:'+p.guid)!==gameAtoms(p.moneyUnits,cfg))throw Error('Unbacked/stale event participant');}
     else{if(p.moneyUnits!=='0')throw Error('Stock money cannot enter atomic event');store.db.prepare('INSERT INTO ac_characters VALUES(?,?,?,?)').run(p.guid,p.accountId,'0',p.version);}
    }
    for(const e of op.expected.escrows){const old=store.db.prepare('SELECT payload FROM ac_escrows WHERE id=?').get(e.id);if(e.absent){if(old)throw Error('Escrow identity cannot be recreated');}
     else if(!old||canonical(JSON.parse(old.payload))!==canonical(escrowState(e))||store.balance('escrow_available','escrow:'+e.id)!==gameAtoms(e.moneyUnits,cfg))throw Error('Unbacked/stale escrow snapshot');}
    store.db.prepare('INSERT INTO ac_operations VALUES(?,?,?,?,NULL)').run(req.id,req.accountId,canonical(op),'reserved');
    for(const key of op.resources)store.db.prepare('INSERT INTO ac_locks VALUES(?,?)').run(key,req.id);
    store.db.prepare('INSERT INTO ac_events VALUES(?,?)').run(req.eventId,req.id);
    store.post({key:'event-reserve:'+req.id,kind:'event-reserve',payload:op,postings:reservePostings(op)});
    return event(req.accountId,req.id);
   });
  },
  async advanceEvent(accountId,id){
   let row=owned(accountId,id),op=JSON.parse(row.payload);if(row.state==='complete')return event(accountId,id);
   if(row.state==='reserved'){
    if(typeof world?.readEventReceipt!=='function'||typeof world?.applyEvent!=='function')throw Error('Atomic LIVE receipt adapter unavailable');
    const proof=await world.readEventReceipt(structuredClone(op))??await world.applyEvent(structuredClone(op));receipt(op,proof);
    store.atomic(()=>{
     const current=owned(accountId,id);if(current.state!=='reserved'){if(current.receipt!==canonical(proof))throw Error('Atomic receipt conflict');return;}
     store.db.prepare('INSERT INTO ac_receipts VALUES(?,?,?)').run(proof.id,id,canonical(proof));
     const applied=proof.outcome==='applied';store.post({key:'event-settle:'+id,kind:applied?'event-applied':'event-rejected',payload:proof,postings:settlementPostings(op,applied)});
     if(applied){
      for(const p of proof.participants)store.db.prepare('UPDATE ac_characters SET units=?,version=? WHERE guid=? AND account_id=?').run(p.moneyUnits,p.version,p.guid,p.accountId);
      for(const e of proof.escrows)store.db.prepare('INSERT INTO ac_escrows VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(e.id,canonical(e));
      for(const p of op.request.participants)if(p.action==='retire')store.db.prepare('INSERT INTO ac_retired VALUES(?,?,?)').run(p.guid,p.accountId,id);
     }
     store.db.prepare("UPDATE ac_operations SET state='awaiting_ack',receipt=? WHERE id=?").run(canonical(proof),id);
    });
   }
   row=owned(accountId,id);if(row.state==='complete')return event(accountId,id);
   const proof=JSON.parse(row.receipt),batchKey='event-settle:'+id,receiptHash=hash(proof);
   if(typeof world?.ackEvent!=='function')throw Error('Atomic durable fence acknowledgement unavailable');
   const ack=await world.ackEvent({operation:structuredClone(op),receiptId:proof.id,receiptHash,batchKey});domain(ack,cfg);
   if(ack.operationId!==id||ack.receiptId!==proof.id||ack.receiptHash!==receiptHash||ack.batchKey!==batchKey)throw Error('Atomic accounting acknowledgement mismatch');
   store.atomic(()=>{const current=owned(accountId,id);if(current.state==='complete')return;if(current.state!=='awaiting_ack'||current.receipt!==canonical(proof))throw Error('Atomic acknowledgement conflict');store.db.prepare("UPDATE ac_operations SET state='complete' WHERE id=?").run(id);store.db.prepare('DELETE FROM ac_locks WHERE operation_id=?').run(id);});
   return event(accountId,id);
  },
 };
}
