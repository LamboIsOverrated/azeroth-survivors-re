import {account,identifier,positive,atoms,canonical,hash} from './amounts.mjs';
import {address,signingAddress,safeInteger,decodeMint,decodeTokenAccount,transferTransaction,signedTransaction,signatureOf,verifyTransferReceipt} from '../../economy/settlement/protocol.mjs';
import {validTransactionError} from './transaction-errors.mjs';
import {nativeTransferTransaction,decodeSystemAccount,verifyNativeTransferReceipt} from '../../economy/settlement/native-sol.mjs';

const FORMAT='withdrawal-v1';
const terminal=new Set(['settled','failed','expired']);
const stages=['withdrawal-reserve','withdrawal-prepared','withdrawal-signed','withdrawal-pending','withdrawal-settled','withdrawal-failed','withdrawal-expired'];

// Injected private adapters only. A signer returns bytes; it MUST NOT submit them.
export function withdrawals({store,rpc,archiveRpc,signer,resolveWallet,clock}){
 const cfg=store.config,db=store.db,native=cfg.assetKind==='native-sol';
 const get=id=>db.prepare('SELECT * FROM ac_operations WHERE id=?').get(id);
 function owned(accountId,id){
  account(accountId);identifier(id);const row=get(id),op=row&&JSON.parse(row.payload);
  if(!row||row.account_id!==accountId||op.format!==FORMAT||op.id!==id||op.request?.accountId!==accountId||op.phase!=='LIVE'||op.namespaceId!==cfg.namespaceId||op.configHash!==cfg.hash)throw Error('Owned LIVE withdrawal required');
  if(!['reserved','signed','pending','complete'].includes(row.state))throw Error('Invalid withdrawal state');return row;
 }
 function view(row){
  const op=JSON.parse(row.payload),proof=row.receipt?JSON.parse(row.receipt):null;
  if(row.state==='complete'&&!terminal.has(proof?.result?.state))throw Error('Durable terminal withdrawal proof required');
   return {...op,...op.request,state:proof?.result?.state??row.state,signature:null,signedTransaction:null,...proof?.unsigned,...proof?.signed,result:proof?.result??null};
 }
 function adapters({needSigner=false,needWallet=false}={}){
  if(typeof rpc?.call!=='function'||typeof archiveRpc?.call!=='function'||typeof rpc.sourceId!=='string'||!rpc.sourceId||typeof archiveRpc.sourceId!=='string'||!archiveRpc.sourceId||rpc.sourceId===archiveRpc.sourceId)throw Error('Distinct trusted primary and archival RPC adapters required');
  if(typeof archiveRpc.proveCompleteAbsence!=='function')throw Error('Reviewed archival completeness witness adapter required');identifier(archiveRpc.completenessPolicyId,'archival completeness policy');
  if(needSigner&&typeof signer?.signTransaction!=='function')throw Error('Transaction-only withdrawal signer unavailable');
  if(needWallet&&typeof resolveWallet!=='function')throw Error('Bound wallet resolver unavailable');
 }
 async function network(provider=rpc){if(await provider.call('getGenesisHash',[])!==cfg.genesisHash)throw Error('Withdrawal RPC genesis mismatch');}
 function floor(){
  let slot=0;
  for(const row of db.prepare('SELECT payload FROM ac_deposits').all()){const proof=JSON.parse(row.payload);slot=Math.max(slot,safeInteger(native?(proof.reserveObservedSlot??proof.slot):proof.slot));}
  for(const row of db.prepare('SELECT kind,payload FROM ac_batches').all())if(stages.includes(row.kind))slot=Math.max(slot,safeInteger(JSON.parse(row.payload).observedSlot));
  return slot;
 }
 async function info(token,minSlot){
  const result=await rpc.call('getAccountInfo',[token,{encoding:'base64',commitment:'finalized',minContextSlot:minSlot}]);
  if(safeInteger(result?.context?.slot)<minSlot)throw Error('Stale withdrawal account proof');return result;
 }
 async function solvent(minSlot=0){
  await network();const minimum=Math.max(minSlot,floor());
  if(native){
   const treasury=await info(cfg.treasuryWallet,minimum),balance=decodeSystemAccount(treasury.value),available=atoms(balance.lamports)-positive(cfg.reserveFloorLamports);
   if(available<0n)throw Error('Treasury reserve floor shortfall');
   const proof={observedSlot:treasury.context.slot,treasuryAtoms:available.toString(),reserveFloorLamports:cfg.reserveFloorLamports};checkSolvent(proof);return proof;
  }
  const mint=await info(cfg.mint,minimum),mintState=decodeMint(mint.value,cfg.decimals);
  const treasury=await info(cfg.treasuryTokenAccount,mint.context.slot),balance=decodeTokenAccount(treasury.value,cfg.mint,cfg.treasuryWallet);
  const proof={observedSlot:treasury.context.slot,treasuryAtoms:balance.atoms,mintSupply:mintState.supply};checkSolvent(proof);return proof;
 }
 function checkSolvent(proof){
  if(safeInteger(proof.observedSlot)<floor())throw Error('Stale reserve observation after concurrent accounting proof');
  const claims=atoms(store.totals().claimsAtoms);
  if(claims>atoms(proof.treasuryAtoms)||(!native&&atoms(proof.treasuryAtoms)>atoms(proof.mintSupply))||(native&&proof.reserveFloorLamports!==cfg.reserveFloorLamports))throw Error('Complete reserve reconciliation failed; claims remain held');
 }
 async function destinationProof(op,minSlot=0){await network();const result=await info(native?op.request.destinationWallet:op.request.destinationTokenAccount,Math.max(minSlot,floor()));if(native)decodeSystemAccount(result.value,{allowMissing:true});else decodeTokenAccount(result.value,cfg.mint,op.wallet);return result.context.slot;}
 function enable(){
  if(db.prepare('SELECT version FROM ac_schema WHERE version=3').get())return;
  if(db.prepare("SELECT COUNT(*) n FROM ac_operations WHERE state!='complete'").get().n||db.prepare('SELECT COUNT(*) n FROM ac_locks').get().n)throw Error('Drain old operations and stop old workers before withdrawal extension');
  db.prepare('INSERT INTO ac_schema VALUES(3,?)').run('conserved-withdrawals-v1');
 }
 function transaction(op,blockhash,netLamports){return native?nativeTransferTransaction({wallet:cfg.treasuryWallet,destination:op.request.destinationWallet,lamports:netLamports??op.request.atoms,memo:op.memo,blockhash}):transferTransaction({wallet:cfg.treasuryWallet,source:cfg.treasuryTokenAccount,mint:cfg.mint,destination:op.request.destinationTokenAccount,atoms:op.request.atoms,decimals:cfg.decimals,memo:op.memo,blockhash});}
 async function unsignedPlan(op,observation){
  const latest=await rpc.call('getLatestBlockhash',[{commitment:'finalized',minContextSlot:observation.observedSlot}]);
  if(safeInteger(latest?.context?.slot)<observation.observedSlot)throw Error('Stale withdrawal blockhash');address(latest?.value?.blockhash);safeInteger(latest.value.lastValidBlockHeight);
  const origin=await rpc.call('getBlock',[latest.context.slot,{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0}]);
  if(!origin||origin.blockhash!==latest.value.blockhash||safeInteger(origin.blockHeight)>latest.context.slot||origin.blockHeight>latest.value.lastValidBlockHeight)throw Error('Exact finalized blockhash origin required');
  const proposed={blockhash:latest.value.blockhash,blockhashSlot:latest.context.slot,blockhashOriginHeight:origin.blockHeight,lastValidBlockHeight:latest.value.lastValidBlockHeight};
  if(native){
   const quote=async tx=>{const value=await rpc.call('getFeeForMessage',[tx.serializeMessage().toString('base64'),{commitment:'finalized',minContextSlot:latest.context.slot}]);if(safeInteger(value?.context?.slot)<latest.context.slot||safeInteger(value.value)===0)throw Error('Exact fresh native fee quote required');return BigInt(value.value);};
   const fee=await quote(transaction(op,proposed.blockhash)),net=positive(op.request.atoms)-fee;if(net<=0n)throw Error('Withdrawal gross debit must exceed network fee');
   if(await quote(transaction(op,proposed.blockhash,net.toString()))!==fee)throw Error('Native fee quote changed for exact payout message');
   Object.assign(proposed,{feeLamports:fee.toString(),netLamports:net.toString(),withdrawalFeePolicy:cfg.withdrawalFeePolicy});
  }
  return proposed;
 }
 function planProof(row){
  const plan=row.receipt&&JSON.parse(row.receipt).unsigned;if(!plan)return null;
  address(plan.blockhash);safeInteger(plan.blockhashSlot);safeInteger(plan.blockhashOriginHeight);safeInteger(plan.lastValidBlockHeight);
  if(plan.blockhashOriginHeight>plan.blockhashSlot||plan.lastValidBlockHeight<plan.blockhashOriginHeight)throw Error('Invalid persisted blockhash origin');
  if(native&&(positive(plan.feeLamports)+positive(plan.netLamports)!==positive(JSON.parse(row.payload).request.atoms)||plan.withdrawalFeePolicy!==cfg.withdrawalFeePolicy))throw Error('Invalid immutable native gross/fee/net plan');return plan;
 }
 function signedProof(row){
  const op=JSON.parse(row.payload),saved=row.receipt&&JSON.parse(row.receipt).signed;
  if(!saved||typeof saved.signedTransaction!=='string')throw Error('Durable signed withdrawal required');
  const plan=planProof(row);if(!plan||canonical(plan)!==canonical({blockhash:saved.blockhash,blockhashSlot:saved.blockhashSlot,blockhashOriginHeight:saved.blockhashOriginHeight,lastValidBlockHeight:saved.lastValidBlockHeight,...(native?{feeLamports:saved.feeLamports,netLamports:saved.netLamports,withdrawalFeePolicy:saved.withdrawalFeePolicy}:{})}))throw Error('Signed transaction lacks its durable verified origin');
  const raw=Buffer.from(saved.signedTransaction,'base64'),tx=signedTransaction(raw);
  if(raw.toString('base64')!==saved.signedTransaction||signatureOf(tx)!==saved.signature||tx.signatures[0].publicKey.toBase58()!==cfg.treasuryWallet||!tx.serializeMessage().equals(transaction(op,saved.blockhash,saved.netLamports).serializeMessage()))throw Error('Stored signed transaction differs from immutable withdrawal');
  return saved;
 }
 function duplicate(row,request,wallet){const op=JSON.parse(row.payload);if(row.account_id!==request.accountId||op.format!==FORMAT||canonical(op.request)!==canonical(request)||op.wallet!==wallet)throw Error('Withdrawal idempotency conflict');return view(row);}
 function errorContext(saved){const tx=signedTransaction(Buffer.from(saved.signedTransaction,'base64'));return {instructionCount:tx.instructions.length,accountCount:tx.compileMessage().accountKeys.length};}
 async function status(provider,saved,minSlot){
  const result=await provider.call('getSignatureStatuses',[[saved.signature],{searchTransactionHistory:true}]);
  if(safeInteger(result?.context?.slot)<minSlot||!Array.isArray(result.value)||result.value.length!==1)throw Error('Invalid/stale withdrawal signature status');
  const value=result.value[0];
  if(value!==null&&(safeInteger(value?.slot)<minSlot||value.slot>result.context.slot||!['processed','confirmed','finalized'].includes(value.confirmationStatus)||!Object.hasOwn(value,'err')||!validTransactionError(value.err,errorContext(saved))))throw Error('Malformed withdrawal status');
  return {value,slot:result.context.slot};
 }
 async function expiry(provider,saved,minSlot){
  await network(provider);const height=safeInteger(await provider.call('getBlockHeight',[{commitment:'finalized',minContextSlot:minSlot}]));
  if(height<=saved.lastValidBlockHeight)return null;
  const validity=await provider.call('isBlockhashValid',[saved.blockhash,{commitment:'finalized',minContextSlot:minSlot}]);
  if(safeInteger(validity?.context?.slot)<minSlot||validity.value!==false)return null;
  const first=safeInteger(await provider.call('getFirstAvailableBlock',[]));if(first>saved.blockhashSlot)return null;
  const signature=await status(provider,saved,validity.context.slot);if(signature.value!==null)return null;
  const receipt=await provider.call('getTransaction',[saved.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  return receipt===null?{sourceId:provider.sourceId,height,firstAvailableBlock:first,observedSlot:signature.slot,blockhashValid:false,status:null,transaction:null}:null;
 }
 async function completeness(saved,boundary){
  const request={kind:'withdrawal-completeness-request-v1',sourceId:archiveRpc.sourceId,policyId:archiveRpc.completenessPolicyId,phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,genesisHash:cfg.genesisHash,signature:saved.signature,blockhash:saved.blockhash,blockhashSlot:saved.blockhashSlot,blockhashOriginHeight:saved.blockhashOriginHeight,lastValidBlockHeight:saved.lastValidBlockHeight,finalizedAfterSlot:boundary.observedSlot,finalizedAfterHeight:boundary.height};
  const witness=await archiveRpc.proveCompleteAbsence(structuredClone(request));
  if(!witness||witness.kind!=='complete-finalized-block-window-v1'||witness.sourceId!==request.sourceId||witness.policyId!==request.policyId||witness.genesisHash!==cfg.genesisHash||witness.namespaceId!==cfg.namespaceId||witness.configHash!==cfg.hash||witness.signature!==saved.signature||witness.blockhash!==saved.blockhash||witness.lastValidBlockHeight!==saved.lastValidBlockHeight||witness.blockhashOriginSlot!==saved.blockhashSlot||witness.blockhashOriginHeight!==saved.blockhashOriginHeight||witness.absent!==true||typeof witness.evidenceHash!=='string'||!/^[0-9a-f]{64}$/.test(witness.evidenceHash))throw Error('Complete bound archival absence witness required');
  for(const key of ['blockhashOriginSlot','blockhashOriginHeight','firstScannedHeight','lastScannedHeight','finalizedSlot','finalizedHeight'])safeInteger(witness[key]);
  if(witness.firstScannedHeight>saved.blockhashOriginHeight||witness.lastScannedHeight<saved.lastValidBlockHeight||witness.lastScannedHeight>witness.finalizedHeight||witness.finalizedHeight<boundary.height||witness.finalizedHeight<=saved.lastValidBlockHeight||witness.finalizedSlot<boundary.observedSlot||witness.finalizedSlot<witness.finalizedHeight)throw Error('Incomplete finalized block-window coverage');
  return structuredClone(witness);
 }
 async function finalizedProof(op,saved,observed){
  const receipt=await rpc.call('getTransaction',[saved.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
  if(!receipt||receipt.version!=='legacy'||!Array.isArray(receipt.transaction)||receipt.transaction.length!==2||receipt.transaction[0]!==saved.signedTransaction||receipt.transaction[1]!=='base64'||safeInteger(receipt.slot)!==observed.value.slot||!receipt.meta||!validTransactionError(receipt.meta.err,errorContext(saved))||canonical(receipt.meta.err)!==canonical(observed.value.err))throw Error('Exact finalized raw withdrawal proof required');
  if(receipt.blockTime!==null)safeInteger(receipt.blockTime);
  if(native){
   const checked=verifyNativeTransferReceipt({receipt,signature:saved.signature,intent:{wallet:cfg.treasuryWallet,destination:op.request.destinationWallet,lamports:saved.netLamports,memo:op.memo,createdSlot:saved.blockhashSlot},expectedFeeLamports:saved.feeLamports,allowFailure:true});
   const chainReceipt=structuredClone({slot:receipt.slot,blockTime:receipt.blockTime,version:'legacy',transaction:receipt.transaction,meta:{err:receipt.meta.err,fee:receipt.meta.fee,preBalances:receipt.meta.preBalances,postBalances:receipt.meta.postBalances,preTokenBalances:receipt.meta.preTokenBalances,postTokenBalances:receipt.meta.postTokenBalances,innerInstructions:receipt.meta.innerInstructions}});
   return {state:checked.failed?'failed':'settled',feeLamports:checked.feeLamports,netLamports:saved.netLamports,slot:checked.slot,observedSlot:observed.slot,sourceId:rpc.sourceId,receiptHash:hash(chainReceipt),chainReceipt};
  }
  if(receipt.meta.err===null)verifyTransferReceipt({receipt,signature:saved.signature,intent:{wallet:cfg.treasuryWallet,sourceTokenAccount:cfg.treasuryTokenAccount,atoms:op.request.atoms,memo:op.memo,createdSlot:saved.blockhashSlot},config:{...cfg,treasuryWallet:op.wallet,treasuryTokenAccount:op.request.destinationTokenAccount}});
  else unchangedTokenBalances(receipt,op,saved);
  const chainReceipt=structuredClone({slot:receipt.slot,blockTime:receipt.blockTime,version:'legacy',transaction:receipt.transaction,meta:{err:receipt.meta.err,preTokenBalances:receipt.meta.preTokenBalances,postTokenBalances:receipt.meta.postTokenBalances,...(receipt.meta.err===null?{innerInstructions:receipt.meta.innerInstructions}:{})}});
  return {state:receipt.meta.err===null?'settled':'failed',slot:receipt.slot,observedSlot:observed.slot,sourceId:rpc.sourceId,receiptHash:hash(chainReceipt),chainReceipt};
 }
 function unchangedTokenBalances(receipt,op,saved){
  const keys=signedTransaction(Buffer.from(saved.signedTransaction,'base64')).compileMessage().accountKeys.map(key=>key.toBase58());
  function balances(rows){
   if(!Array.isArray(rows)||rows.length!==2)throw Error('Complete no-change token balances required for failure');const values=new Map();
   for(const row of rows){
    const key=keys[safeInteger(row.accountIndex)],owner=key===cfg.treasuryTokenAccount?cfg.treasuryWallet:key===op.request.destinationTokenAccount?op.wallet:null;
    if(!owner||values.has(key)||row.owner!==owner||row.mint!==cfg.mint||row.programId!==cfg.tokenProgram||row.uiTokenAmount?.decimals!==cfg.decimals)throw Error('Failure token ownership/mint/program mismatch');values.set(key,atoms(row.uiTokenAmount.amount));
   }
   return values;
  }
  const before=balances(receipt.meta.preTokenBalances),after=balances(receipt.meta.postTokenBalances);
  for(const [key,value]of before)if(after.get(key)!==value)throw Error('Claimed failure contradicts token movement');
 }
 return {
  withdrawal(accountId,id){return view(owned(accountId,id));},
  pendingWithdrawals({afterId=null,limit=50}={}){
   if(afterId!==null)identifier(afterId);if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Bounded withdrawal recovery page required');
   const rows=db.prepare("SELECT * FROM ac_operations WHERE json_extract(payload,'$.format')=? AND state!='complete' AND id>? ORDER BY id LIMIT ?").all(FORMAT,afterId??'',limit+1);
   return {entries:rows.slice(0,limit).map(view),nextCursor:rows.length>limit?rows[limit-1].id:null};
  },
  async reserveWithdrawal({accountId,id,atoms:amount,destinationTokenAccount,destinationWallet}){
   if(native?destinationTokenAccount!==undefined:destinationWallet!==undefined)throw Error('Withdrawal destination asset mismatch');
   const request={accountId:account(accountId),id:identifier(id),atoms:positive(amount).toString(),...(native?{destinationWallet:signingAddress(destinationWallet)}:{destinationTokenAccount:address(destinationTokenAccount)})};
   adapters({needSigner:true,needWallet:true});signingAddress(cfg.treasuryWallet);const wallet=signingAddress(await resolveWallet(accountId));
   if(wallet===cfg.treasuryWallet||(native?destinationWallet!==wallet:destinationTokenAccount===cfg.treasuryTokenAccount))throw Error('Withdrawal must target bound wallet outside treasury');
   const prior=get(id);if(prior)return duplicate(prior,request,wallet);
   await network(archiveRpc);const op={format:FORMAT,phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,id,request,wallet,createdAt:safeInteger(clock()),memo:`realm-live:withdrawal:${cfg.hash}:${accountId}:${id}`};
   const destinationSlot=await destinationProof(op),observation=await solvent(destinationSlot);
   // A native request must afford its exact gross/fee/net payment before any
   // claim or account lock exists. Its plan and reservation commit together.
   const plan=native?await unsignedPlan(op,observation):null;
   return store.atomic(()=>{
    const race=get(id);if(race)return duplicate(race,request,wallet);checkSolvent(observation);enable();
    db.prepare('INSERT INTO ac_operations VALUES(?,?,?,?,?)').run(id,accountId,canonical(op),'reserved',plan?canonical({unsigned:plan,signed:null,result:null}):null);
    db.prepare('INSERT INTO ac_locks VALUES(?,?)').run('account:'+accountId,id);
    store.post({key:'withdrawal-reserve:'+id,kind:'withdrawal-reserve',payload:{operation:op,...observation},postings:[{bucket:'vault_available',owner:'account:'+accountId,delta:-positive(amount)},{bucket:'withdrawal_reserved',owner:'operation:'+id,delta:positive(amount)}]});
    if(plan)store.post({key:'withdrawal-prepared:'+id,kind:'withdrawal-prepared',payload:{operationId:id,unsigned:plan,observedSlot:plan.blockhashSlot},postings:[]});
    return view(owned(accountId,id));
   });
  },
  async prepareWithdrawal(accountId,id){
   const row=owned(accountId,id);if(row.state!=='reserved')return view(row);adapters({needSigner:true});await network(archiveRpc);
   const op=JSON.parse(row.payload);let plan=planProof(row);
   if(!plan){
    if(native)throw Error('Native reservation lacks its immutable pre-reservation fee plan');
    const destinationSlot=await destinationProof(op),observation=await solvent(destinationSlot),proposed=await unsignedPlan(op,observation);
    plan=store.atomic(()=>{
     const current=owned(accountId,id),prior=planProof(current);if(prior)return prior;checkSolvent(observation);
     store.post({key:'withdrawal-prepared:'+id,kind:'withdrawal-prepared',payload:{operationId:id,unsigned:proposed,observedSlot:proposed.blockhashSlot},postings:[]});
     db.prepare('UPDATE ac_operations SET receipt=? WHERE id=?').run(canonical({unsigned:proposed,signed:null,result:null}),id);return proposed;
    });
   }
   const destinationSlot=await destinationProof(op,plan.blockhashSlot),observation=await solvent(destinationSlot),beforeSign=owned(accountId,id);if(beforeSign.state!=='reserved')return view(beforeSign);checkSolvent(observation);
   const tx=transaction(op,plan.blockhash,plan.netLamports),message=tx.serializeMessage(),raw=await signer.signTransaction(Uint8Array.from(tx.serialize({requireAllSignatures:false,verifySignatures:false}))),signed=signedTransaction(raw);
   if(!signed.serializeMessage().equals(message)||signed.signatures[0].publicKey.toBase58()!==cfg.treasuryWallet)throw Error('Signer changed exact withdrawal');
   const saved={signedTransaction:signed.serialize().toString('base64'),signature:signatureOf(signed),...plan};
   return store.atomic(()=>{
    const current=owned(accountId,id);if(current.state!=='reserved')return view(current);checkSolvent(observation);
    store.post({key:'withdrawal-signed:'+id,kind:'withdrawal-signed',payload:{operationId:id,signed:saved,observedSlot:observation.observedSlot},postings:[]});
    db.prepare("UPDATE ac_operations SET state='signed',receipt=? WHERE id=?").run(canonical({unsigned:plan,signed:saved,result:null}),id);return view(owned(accountId,id));
   });
  },
  async broadcastWithdrawal(accountId,id){
   const row=owned(accountId,id);if(row.state==='complete')return view(row);adapters();await network(archiveRpc);const saved=signedProof(row),observation=await solvent(saved.blockhashSlot);
   const current=store.atomic(()=>{
    const value=owned(accountId,id);if(value.state==='complete')return value;signedProof(value);checkSolvent(observation);
    if(value.state==='signed'){
     store.post({key:'withdrawal-pending:'+id,kind:'withdrawal-pending',payload:{operationId:id,signature:saved.signature,...observation},postings:[]});db.prepare("UPDATE ac_operations SET state='pending' WHERE id=?").run(id);
    }else if(value.state!=='pending')throw Error('Durable signed withdrawal required');return owned(accountId,id);
   });
   if(current.state==='complete')return view(current);
   try{const result=await rpc.call('sendTransaction',[saved.signedTransaction,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'finalized',minContextSlot:saved.blockhashSlot}]);if(result!==saved.signature)throw Error('RPC signature mismatch');}catch{/* An ambiguous send NEVER releases claims. */}
   return view(owned(accountId,id));
  },
  async reconcileWithdrawal(accountId,id){
   const row=owned(accountId,id);if(row.state==='complete'||row.state==='reserved')return view(row);
   let result;const op=JSON.parse(row.payload),saved=signedProof(row);
   try{
    adapters();await network();const observed=await status(rpc,saved,saved.blockhashSlot);
    if(observed.value?.confirmationStatus==='finalized')result=await finalizedProof(op,saved,observed);
    else if(observed.value===null){const minimum=Math.max(saved.blockhashSlot,floor()),primary=await expiry(rpc,saved,minimum),archive=primary&&await expiry(archiveRpc,saved,minimum);if(primary&&archive){const complete=await completeness(saved,{height:Math.max(primary.height,archive.height),observedSlot:Math.max(primary.observedSlot,archive.observedSlot)});result={state:'expired',observedSlot:Math.max(primary.observedSlot,archive.observedSlot,complete.finalizedSlot),witnesses:[primary,archive],completenessWitness:complete};}}
   }catch{return view(owned(accountId,id));}
   if(!result)return view(owned(accountId,id));
   const proof={format:'withdrawal-result-v1',phase:'LIVE',namespaceId:cfg.namespaceId,configHash:cfg.hash,operationId:id,accountId,signature:saved.signature,...result};
   return store.atomic(()=>{
    const current=owned(accountId,id);if(current.state==='complete')return view(current);signedProof(current);
    const amount=positive(op.request.atoms),settled=result.state==='settled',failedNative=native&&result.state==='failed';
    const postings=failedNative?[{bucket:'withdrawal_reserved',owner:'operation:'+id,delta:-amount},{bucket:'vault_available',owner:'account:'+accountId,delta:amount-positive(result.feeLamports)},{bucket:'external_reserve',owner:'system',delta:positive(result.feeLamports)}]:[{bucket:'withdrawal_reserved',owner:'operation:'+id,delta:-amount},settled?{bucket:'external_reserve',owner:'system',delta:amount}:{bucket:'vault_available',owner:'account:'+accountId,delta:amount}];
    store.post({key:'withdrawal-result:'+id,kind:'withdrawal-'+result.state,payload:proof,postings});
    db.prepare('INSERT INTO ac_receipts VALUES(?,?,?)').run('withdrawal:'+hash(saved.signature),id,canonical(proof));
    db.prepare("UPDATE ac_operations SET state='complete',receipt=? WHERE id=?").run(canonical({unsigned:planProof(current),signed:saved,result:proof}),id);db.prepare('DELETE FROM ac_locks WHERE operation_id=?').run(id);return view(owned(accountId,id));
   });
  },
 };
}
