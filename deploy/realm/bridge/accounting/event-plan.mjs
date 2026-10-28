import {account,identifier,units,atoms,gameAtoms,canonical,hash,GAME_MAX,U64} from './amounts.mjs';

export const digest=value=>{if(typeof value!=='string'||! /^[0-9a-f]{64}$/.test(value))throw Error('Exact gameplay digest required');return value;};
export function characterGuid(value){if(typeof value!=='string'||! /^[1-9][0-9]{0,9}$/.test(value)||BigInt(value)>4294967295n)throw Error('Canonical character GUID required');return value;}
const families=new Set(['trade','quest-reward','loot','vendor-sale','service','starting-money','mail-send','mail-cod','mail-take','mail-return','mail-expire','auction-list','auction-bid','auction-settle','auction-cancel','escrow-recover','escrow-claim','escrow-delete','character-delete']);
const actions=new Set(['create','keep','settle','return','expire','delete']);
const kinds=new Set(['mail','auction','trade','recovery']);
function exact(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!keys.includes(k)))throw Error('Unknown event field');}
function sortedUnique(rows,key){const result=[...rows].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);if(new Set(result.map(key)).size!==result.length)throw Error('Duplicate event participant/resource');return result;}
export function owner(value){
 exact(value,['type','accountId','guid','id']);
 if(value.type==='character'){if(value.id!==undefined)throw Error('Invalid character owner');return {type:'character',accountId:account(value.accountId),guid:characterGuid(value.guid)};}
 if(!['pool','escrow'].includes(value.type)||value.accountId!==undefined||value.guid!==undefined)throw Error('Typed claim owner required');
 return {type:value.type,id:identifier(value.id)};
}
export const ownerKey=value=>value.type==='character'?'character:'+value.guid:value.type+':'+value.id;
export const bucket=value=>value.type==='character'?'world_allocated':value.type==='pool'?'pool_available':'escrow_available';
export function eventRequest(input){
 exact(input,['id','accountId','eventId','family','planDigest','participants','escrows','legs']);
 if(!families.has(input.family)||!Array.isArray(input.participants)||input.participants.length>16||!Array.isArray(input.escrows)||input.escrows.length>16||!Array.isArray(input.legs)||input.legs.length>32)throw Error('Bounded typed event required');
 const participants=sortedUnique(input.participants.map(p=>{exact(p,['accountId','guid','afterStateHash','action']);const value={accountId:account(p.accountId),guid:characterGuid(p.guid),afterStateHash:digest(p.afterStateHash),action:p.action??'keep'};if(!['keep','retire'].includes(value.action))throw Error('Unknown character lifecycle');return value;}),p=>p.guid);
 const escrows=sortedUnique(input.escrows.map(a=>{
  exact(a,['id','action','kind','ownerAccountId','beneficiaryAccountId','retainedAccountId','expiresAt']);const value={id:identifier(a.id),action:a.action};if(!actions.has(a.action))throw Error('Unknown escrow transition');
  if(a.action==='create'){if(!kinds.has(a.kind))throw Error('Typed escrow required');Object.assign(value,{kind:a.kind,ownerAccountId:account(a.ownerAccountId),beneficiaryAccountId:account(a.beneficiaryAccountId),retainedAccountId:account(a.retainedAccountId),expiresAt:a.expiresAt});if(!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0)throw Error('Exact escrow deadline required');if(value.retainedAccountId!==value.ownerAccountId)throw Error('Retained claims must belong to the original funding owner');}
  else if(Object.keys(a).some(k=>!['id','action'].includes(k)))throw Error('Existing escrow metadata immutable');return value;
 }),a=>a.id);
 const ids=new Set();const legs=input.legs.map(l=>{
  exact(l,['id','from','to','units']);const value={id:identifier(l.id),from:owner(l.from),to:owner(l.to),units:units(l.units).toString()};
  if(ids.has(value.id)||value.units==='0'||ownerKey(value.from)===ownerKey(value.to))throw Error('Distinct positive event legs required');ids.add(value.id);
  for(const endpoint of [value.from,value.to])if(endpoint.type==='character'&&!participants.some(p=>p.accountId===endpoint.accountId&&p.guid===endpoint.guid)||endpoint.type==='escrow'&&!escrows.some(a=>a.id===endpoint.id))throw Error('All leg actors must be declared');
  return value;
 });
 if(!participants.length&&!escrows.length)throw Error('Event resources required');
 if(!legs.length&&!['mail-return','mail-expire','escrow-delete','character-delete'].includes(input.family))throw Error('Money event legs required');
 if(participants.some(p=>p.action==='retire')&&input.family!=='character-delete')throw Error('Retirement requires deletion event');
 if(input.family==='character-delete'&&(!participants.length||participants.some(p=>p.action!=='retire')))throw Error('Character deletion must retire every declared character');
 if(input.family==='escrow-delete'&&!escrows.some(a=>a.action==='delete'))throw Error('Escrow deletion requires a terminal source');
 if(['mail-return','mail-expire'].includes(input.family)&&!escrows.length)throw Error('Mail lifecycle resource required');
 return {id:identifier(input.id),accountId:account(input.accountId),eventId:identifier(input.eventId),family:input.family,planDigest:digest(input.planDigest),participants,escrows,legs};
}
export function domain(value,cfg){if(!value||value.phase!=='LIVE'||value.namespaceId!==cfg.namespaceId||value.configHash!==cfg.hash)throw Error('LIVE namespace proof required');}
export function escrowState(value){
 if(!value||typeof value!=='object')throw Error('Complete escrow state required');
 const result={id:identifier(value.id),kind:value.kind,ownerAccountId:account(value.ownerAccountId),beneficiaryAccountId:account(value.beneficiaryAccountId),retainedAccountId:account(value.retainedAccountId),expiresAt:value.expiresAt,state:value.state,moneyUnits:units(value.moneyUnits).toString(),version:atoms(value.version).toString()};
 if(!kinds.has(result.kind)||!['open','returned','expired','settled','deleted'].includes(result.state)||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<0)throw Error('Invalid escrow metadata');return result;
}
function policy(request,states){
 for(const l of request.legs){
  const f=l.from.type,t=l.to.type,esc=id=>states.get(id),is=(id,kind)=>esc(id)?.kind===kind;
  const allowed={
   trade:f==='character'&&t==='character',
   'quest-reward':f==='pool'&&t==='character'||f==='character'&&t==='pool',
   loot:f==='pool'&&t==='character','vendor-sale':f==='pool'&&t==='character','starting-money':f==='pool'&&t==='character',
   service:f==='character'&&t==='pool',
   'mail-send':f==='character'&&(t==='pool'||t==='escrow'&&is(l.to.id,'mail')),
   'mail-cod':f==='character'&&t==='escrow'&&is(l.to.id,'mail'),
   'mail-take':f==='escrow'&&is(l.from.id,'mail')&&t==='character',
   'mail-return':false,'mail-expire':false,
   'auction-list':f==='character'&&(t==='pool'||t==='escrow'&&is(l.to.id,'auction')),
   'auction-bid':f==='character'&&t==='escrow'&&is(l.to.id,'auction')||f==='escrow'&&is(l.from.id,'auction')&&t==='escrow'&&is(l.to.id,'mail'),
   'auction-settle':f==='escrow'&&is(l.from.id,'auction')&&(t==='pool'||t==='escrow'&&is(l.to.id,'mail')),
   'auction-cancel':f==='character'&&t==='pool'||f==='escrow'&&is(l.from.id,'auction')&&t==='escrow'&&is(l.to.id,'mail'),
   'escrow-claim':f==='escrow'&&is(l.from.id,'recovery')&&t==='character',
   'escrow-recover':f==='escrow'&&t==='escrow'&&is(l.to.id,'recovery'),
   'escrow-delete':f==='escrow'&&t==='escrow'&&is(l.to.id,'recovery'),
   'character-delete':f==='character'&&t==='escrow'&&is(l.to.id,'recovery'),
  }[request.family];
  if(!allowed)throw Error('Event family cannot authorize this leg');
  if(f==='escrow'&&t==='character'&&esc(l.from.id).beneficiaryAccountId!==l.to.accountId)throw Error('Escrow recipient is not its beneficiary');
  if(f==='character'&&t==='escrow'&&esc(l.to.id).ownerAccountId!==l.from.accountId)throw Error('Escrow funding owner mismatch');
  if(f==='escrow'&&t==='escrow'&&is(l.to.id,'recovery')&&esc(l.to.id).beneficiaryAccountId!==esc(l.from.id).retainedAccountId)throw Error('Recovery beneficiary mismatch');
  if(f==='escrow'&&t==='escrow'&&['auction-bid','auction-settle','auction-cancel'].includes(request.family)){
   const beneficiary=request.family==='auction-settle'?esc(l.from.id).beneficiaryAccountId:esc(l.from.id).retainedAccountId;
   if(esc(l.to.id).beneficiaryAccountId!==beneficiary)throw Error('Auction proceeds/refund beneficiary mismatch');
  }
  if(request.family==='character-delete'&&esc(l.to.id).beneficiaryAccountId!==l.from.accountId)throw Error('Retired claim recovery owner mismatch');
 }
}
export function compileEvent(req,proof,cfg,now){
 if(!Number.isSafeInteger(now)||now<0)throw Error('Trusted exact maintenance clock required');
 domain(proof,cfg);if(proof.requestHash!==hash(req)||!Array.isArray(proof.participants)||!Array.isArray(proof.escrows)||proof.participants.length!==req.participants.length||proof.escrows.length!==req.escrows.length)throw Error('Complete event snapshot required');
 const expected={participants:[],escrows:[]},after={participants:[],escrows:[]},state=new Map(),accounts=new Set([req.accountId]),resources=new Set(),sources=new Map(),targets=new Map(),mutations=[];
 for(const p of req.participants){
  const rows=proof.participants.filter(x=>x.guid===p.guid);if(rows.length!==1)throw Error('Duplicate/missing actor snapshot');const s=rows[0];domain(s,cfg);
  if(s.accountId!==p.accountId)throw Error('Actor ownership mismatch');units(s.moneyUnits);atoms(s.version);digest(s.gameplayStateHash);if(BigInt(s.version)===U64)throw Error('Actor version exhausted');
  const clean={phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,accountId:p.accountId,guid:p.guid,moneyUnits:s.moneyUnits,version:s.version,gameplayStateHash:s.gameplayStateHash};expected.participants.push(clean);
  state.set('character:'+p.guid,{...clean});accounts.add(p.accountId);resources.add(p.guid);
 }
 const escrowStates=new Map();
 for(const a of req.escrows){
  const rows=proof.escrows.filter(x=>x.id===a.id);if(rows.length!==1)throw Error('Duplicate/missing escrow snapshot');const value=rows[0];let s;
  if(a.action==='create'){if(canonical(value)!==canonical({id:a.id,absent:true}))throw Error('New escrow needs absence proof');expected.escrows.push({id:a.id,absent:true});s={id:a.id,kind:a.kind,ownerAccountId:a.ownerAccountId,beneficiaryAccountId:a.beneficiaryAccountId,retainedAccountId:a.retainedAccountId,expiresAt:a.expiresAt,state:'open',moneyUnits:'0',version:'0'};}
  else{s=escrowState(value);if(['settled','deleted'].includes(s.state)||BigInt(s.version)===U64)throw Error('Terminal/exhausted escrow');expected.escrows.push(s);}
  for(const accountId of [s.ownerAccountId,s.beneficiaryAccountId,s.retainedAccountId])accounts.add(accountId);
  state.set('escrow:'+a.id,{...s});escrowStates.set(a.id,s);resources.add('escrow:'+a.id);
 }
 policy(req,escrowStates);
 function accumulate(map,endpoint,amount){const key=ownerKey(endpoint);const old=map.get(key);map.set(key,{owner:endpoint,atoms:((old?.atoms??0n)+amount)});}
 for(const l of req.legs){
  const amount=BigInt(gameAtoms(l.units,cfg));accumulate(sources,l.from,amount);accumulate(targets,l.to,amount);
  for(const [side,endpoint,delta]of [['debit',l.from,-units(l.units)],['credit',l.to,units(l.units)]]){
   if(endpoint.type==='pool')continue;
   const key=ownerKey(endpoint),current=state.get(key),before=units(current.moneyUnits),next=before+delta;
   if(next<0n||next>GAME_MAX)throw Error('Intermediate/final money bounds');
   mutations.push({namespaceId:cfg.namespaceId,configHash:cfg.hash,operationId:req.id,requestHash:hash(req),ownerVersion:current.version,eventId:req.eventId,legId:l.id,side,owner:endpoint,deltaUnits:delta.toString(),beforeUnits:before.toString(),afterUnits:next.toString()});current.moneyUnits=next.toString();
  }
 }
 for(const p of req.participants){const s=state.get('character:'+p.guid);if(p.action==='retire'&&s.moneyUnits!=='0')throw Error('Retirement must relocate every claim');after.participants.push({...s,version:(BigInt(s.version)+1n).toString(),gameplayStateHash:p.afterStateHash});}
 for(const a of req.escrows){
  const s=state.get('escrow:'+a.id),old=escrowStates.get(a.id),touched=req.legs.some(l=>ownerKey(l.from)==='escrow:'+a.id||ownerKey(l.to)==='escrow:'+a.id);
  if(a.action==='return'||a.action==='expire'){
   if(old.state!=='open'||old.kind!=='mail'||touched||req.family!==(a.action==='return'?'mail-return':'mail-expire')||a.action==='expire'&&(old.expiresAt===0||now<old.expiresAt))throw Error('Invalid return/expiry transition');
   s.state=a.action==='return'?'returned':'expired';s.beneficiaryAccountId=s.retainedAccountId;
  }
  if(a.action==='delete'||a.action==='settle'){if(s.moneyUnits!=='0')throw Error('Terminal escrow must have zero claims');s.state=a.action==='delete'?'deleted':'settled';}
  if(a.action==='delete'&&req.family!=='escrow-delete')throw Error('Escrow deletion requires recovery event');
  if(req.family==='escrow-delete'&&a.action!=='create'&&a.action!=='delete')throw Error('Deletion must persist the terminal source identity');
  if(['mail-take','auction-settle','auction-cancel','auction-bid'].includes(req.family)&&req.legs.some(l=>l.from.type==='escrow'&&l.from.id===a.id)&&a.action!=='settle')throw Error('Escrow checkout/refund requires its complete terminal transition');
  if(a.action==='keep'&&old.state!=='open'&&req.legs.some(l=>ownerKey(l.to)==='escrow:'+a.id))throw Error('Returned/expired escrow cannot receive new claims');
  if(req.family==='mail-return'&&a.action!=='return'||req.family==='mail-expire'&&a.action!=='expire')throw Error('Lifecycle event must transition every escrow');
  after.escrows.push({...s,version:(BigInt(s.version)+1n).toString()});
 }
 for(const id of [...accounts].sort((a,b)=>a-b))resources.add('account:'+id);
 return {expected,after,sources:[...sources.values()],targets:[...targets.values()],resources:[...resources].sort(),mutations};
}
