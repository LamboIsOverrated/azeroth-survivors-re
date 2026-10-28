import {address,signingAddress,decodeMint,decodeTokenAccount,verifyDepositReceipt,signatureText,safeInteger} from '../../economy/settlement/protocol.mjs';
import {atoms,positive,account,identifier,canonical} from './amounts.mjs';

// Read-only proof adapter. No old settlement journal, signer, broadcast method or public route.
export function deposits({store,rpc,resolveWallet,clock}){
 const cfg=store.config;
 async function network(){if(await rpc.call('getGenesisHash',[])!==cfg.genesisHash)throw Error('Chain genesis mismatch');}
 async function info(address,minSlot=0){
  const response=await rpc.call('getAccountInfo',[address,{encoding:'base64',commitment:'finalized',minContextSlot:minSlot}]);
  if(safeInteger(response?.context?.slot)<minSlot)throw Error('Stale account proof');return response.value;
 }
 const existing=id=>store.db.prepare('SELECT * FROM ac_intents WHERE id=?').get(id);
 return {
  async create({accountId,id,atoms:amount,sourceTokenAccount}){
   account(accountId);identifier(id);positive(amount);address(sourceTokenAccount);
   const prior=existing(id);
   if(prior){const value=JSON.parse(prior.payload);if(prior.account_id!==accountId||value.atoms!==amount||value.sourceTokenAccount!==sourceTokenAccount)throw Error('Deposit intent conflict');return value;}
   if(typeof resolveWallet!=='function'||typeof rpc?.call!=='function')throw Error('Verified deposit adapters unavailable');
   const wallet=signingAddress(await resolveWallet(accountId));await network();
   decodeMint(await info(cfg.mint),cfg.decimals);decodeTokenAccount(await info(sourceTokenAccount),cfg.mint,wallet);decodeTokenAccount(await info(cfg.treasuryTokenAccount),cfg.mint,cfg.treasuryWallet);
   const createdSlot=safeInteger(await rpc.call('getSlot',[{commitment:'finalized'}])),now=clock();safeInteger(now);
   const intent={phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,id,accountId,wallet,sourceTokenAccount,atoms:amount,createdSlot,expiresAt:now+900000,memo:`realm-live:${cfg.hash}:${accountId}:${id}`};
   return store.atomic(()=>{
    const race=existing(id);if(race){const value=JSON.parse(race.payload);if(race.account_id!==accountId||value.atoms!==amount||value.sourceTokenAccount!==sourceTokenAccount||value.wallet!==wallet)throw Error('Deposit intent conflict');return value;}
    store.db.prepare('INSERT INTO ac_intents VALUES(?,?,?)').run(id,accountId,canonical(intent));return intent;
   });
  },
  async confirm({accountId,id,signature}){
   account(accountId);identifier(id);signatureText(signature);
   const intentRow=existing(id);if(!intentRow||intentRow.account_id!==accountId)throw Error('Account deposit intent required');
   const intent=JSON.parse(intentRow.payload);
   const prior=store.db.prepare('SELECT * FROM ac_deposits WHERE signature=? OR intent_id=?').all(signature,id);
   function duplicate(rows){if(rows.length!==1||rows[0].signature!==signature||rows[0].intent_id!==id||rows[0].account_id!==accountId)throw Error('Deposit signature/intent replay conflict');return JSON.parse(rows[0].payload);}
   if(prior.length)return duplicate(prior);
   await network();
   const statusResponse=await rpc.call('getSignatureStatuses',[[signature],{searchTransactionHistory:true}]),status=statusResponse?.value?.[0];
   if(!status||status.err!==null||status.confirmationStatus!=='finalized')throw Error('Finalized deposit required');
   safeInteger(status.slot);
   const receipt=await rpc.call('getTransaction',[signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
   const verified=verifyDepositReceipt({receipt,signature,intent,config:cfg});
   if(status.slot!==verified.slot||safeInteger(statusResponse.context.slot)<verified.slot)throw Error('Deposit slot proof mismatch');
   const mint=decodeMint(await info(cfg.mint,verified.slot),cfg.decimals),treasury=decodeTokenAccount(await info(cfg.treasuryTokenAccount,verified.slot),cfg.mint,cfg.treasuryWallet);
   const proof={signature,intentId:id,accountId,atoms:verified.atoms,slot:verified.slot,phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash};
   return store.atomic(()=>{
    const race=store.db.prepare('SELECT * FROM ac_deposits WHERE signature=? OR intent_id=?').all(signature,id);if(race.length)return duplicate(race);
    const reserve=BigInt(store.totals().reserveAtoms)+atoms(proof.atoms);
    if(reserve>atoms(treasury.atoms)||reserve>atoms(mint.supply))throw Error('Observed finalized treasury cannot cover claims');
    store.post({key:'deposit:'+id,kind:'deposit',payload:proof,postings:[{bucket:'external_reserve',owner:'system',delta:-atoms(proof.atoms)},{bucket:'vault_available',owner:'account:'+accountId,delta:atoms(proof.atoms)}]});
    store.db.prepare('INSERT INTO ac_deposits VALUES(?,?,?,?)').run(signature,id,accountId,canonical(proof));return proof;
   });
  },
 };
}
