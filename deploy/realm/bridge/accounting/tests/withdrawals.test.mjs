import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Transaction} from '@solana/web3.js';
import {createAccounting} from '../kernel.mjs';
import {withdrawalFixture,reserve,finalized,destination,treasury,tokenInfo} from './withdrawal-fixtures.mjs';
import {deposit} from './fixtures.mjs';
import {pairs,signFixture,source} from '../../../economy/settlement/tests/fixtures.mjs';
import {receipt} from '../../../economy/settlement/tests/fixtures.mjs';
import {signatureOf} from '../../../economy/settlement/protocol.mjs';
import {eventWorld,quote,character,pool,escrow} from './event-fixtures.mjs';

test('verified deposit, world grant, redemption and withdrawal conserve one journal through finalized settlement',async t=>{
 const f=await withdrawalFixture(t),{k,deps}=f;
 await k.prepareWorld({id:'grant',accountId:1,guid:'10',kind:'grant',units:'20'});await k.advanceWorld(1,'grant');
 await k.prepareWorld({id:'redeem',accountId:1,guid:'10',kind:'redeem',units:'5'});await k.advanceWorld(1,'redeem');
 const held=await reserve(k);assert.equal(held.accountId,1);assert.equal(held.atoms,'1000');assert.equal(held.state,'reserved');assert.equal(k.balance(1).vaultAtoms,'7500');
 assert.equal((await reserve(k)).id,'withdraw1');assert.deepEqual(k.totals(),{reserveAtoms:'10000',claimsAtoms:'10000'});
 const signed=await k.prepareWithdrawal(1,'withdraw1');finalized(deps,signed);
 const settled=await k.reconcileWithdrawal(1,'withdraw1');assert.equal(settled.state,'settled');assert.equal(settled.result.chainReceipt.transaction[0],signed.signedTransaction);assert.equal(settled.result.chainReceipt.meta.postTokenBalances[1].uiTokenAmount.amount,'1000');await k.reconcileWithdrawal(1,'withdraw1');
 assert.deepEqual(k.totals(),{reserveAtoms:'9000',claimsAtoms:'9000'});assert.equal(k.balance(1).worldAtoms,'1500');assert.equal(k.character(1,'10').moneyUnits,'15');
 const terminalDb=new DatabaseSync(f.path);try{assert.throws(()=>terminalDb.prepare("UPDATE ac_operations SET receipt=json_set(receipt,'$.result.state','failed') WHERE id='withdraw1'").run(),/immutable/i);assert.throws(()=>terminalDb.prepare("UPDATE ac_operations SET state='reserved' WHERE id='withdraw1'").run(),/state|terminal/i);}finally{terminalDb.close();}
 f.restart();assert.equal(f.k.withdrawal(1,'withdraw1').state,'settled');assert.throws(()=>f.k.withdrawal(2,'withdraw1'));
});

test('withdrawal reservation binds wallet/destination/account and cannot overdraw or bypass shared world/event locks',async t=>{
 const f=await withdrawalFixture(t),{k,deps}=f;eventWorld(deps.world,f.config);
 for(const atoms of ['0','01','-1','1.2',1000,'18446744073709551616'])await assert.rejects(reserve(k,'bad',1,atoms));
 await assert.rejects(reserve(k,'overdraw',1,'10001'));k.fundPool({id:'lock-test-fund',accountId:1,poolId:'lock-test',atoms:'100'});
 await reserve(k);await assert.rejects(reserve(k,'withdraw1',1,'1001'));
 await assert.rejects(k.reserveWithdrawal({accountId:2,id:'withdraw1',atoms:'1000',destinationTokenAccount:destination}));
 await assert.rejects(k.reserveWithdrawal({accountId:1,id:'withdraw1',atoms:'1000',destinationTokenAccount:source}));
 deps.resolveWallet=async()=>pairs[0].publicKey.toBase58();f.restart();await assert.rejects(reserve(f.k));
 await assert.rejects(f.k.prepareWorld({id:'blocked-world',accountId:1,guid:'10',kind:'grant',units:'1'}));
 await assert.rejects(f.k.prepareEvent(quote({id:'blocked-event',family:'quest-reward',participants:[{accountId:1,guid:'10'}],legs:[{id:'reward',from:pool('lock-test'),to:character(1,'10'),units:'1'}]})));
 assert.equal(f.k.balance(1).vaultAtoms,'8900');assert.equal(f.k.pool('lock-test').availableAtoms,'100');assert.equal(f.k.pendingWithdrawals().entries.length,1);
});

test('extension activation preserves incompatible pending operations and drains before adding its durable marker',async t=>{
 const f=await withdrawalFixture(t);await f.k.prepareWorld({id:'old',accountId:1,guid:'10',kind:'grant',units:'1'});
 await assert.rejects(reserve(f.k));assert.equal(f.k.operation(1,'old').state,'reserved');
 const db=new DatabaseSync(f.path);assert.equal(db.prepare('SELECT COUNT(*) n FROM ac_schema WHERE version=3').get().n,0);db.close();
 await f.k.advanceWorld(1,'old');await reserve(f.k);
 const read=new DatabaseSync(f.path);assert.equal(read.prepare('SELECT contract FROM ac_schema WHERE version=3').get().contract,'conserved-withdrawals-v1');read.close();
 assert.equal(f.k.config.atomsPerGameUnit,'100');
});

test('missing signer, independent archive or RPC configuration fails closed before a claim is reserved',async t=>{
 const f=await withdrawalFixture(t);
 for(const changed of [{signer:null},{rpc:null},{archiveRpc:null},{archiveRpc:f.deps.rpc},{archiveRpc:{...f.deps.archiveRpc,sourceId:f.deps.rpc.sourceId}}]){
  const k=createAccounting({path:f.path,config:f.config,...f.deps,...changed});try{await assert.rejects(reserve(k));assert.equal(k.balance(1).vaultAtoms,'10000');}finally{k.close();}
 }
});

test('signer substitutions cannot change any encoded withdrawal instruction, mint, amount, destination or blockhash',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);
 for(const change of [tx=>tx.instructions[0].data.writeBigUInt64LE(1001n,1),tx=>tx.instructions[0].keys[1].pubkey=pairs[1].publicKey,tx=>tx.instructions[0].keys[2].pubkey=pairs[1].publicKey,tx=>tx.recentBlockhash=source,tx=>tx.instructions.push(tx.instructions[1])]){
  f.deps.signer={signTransaction:async bytes=>{const tx=Transaction.from(bytes);change(tx);return signFixture(tx,pairs[0]).serialize();}};f.restart();
  await assert.rejects(f.k.prepareWithdrawal(1,'withdraw1'));assert.equal(f.k.withdrawal(1,'withdraw1').state,'reserved');
 }
 assert.equal(f.deps.rpc.calls.filter(c=>c.method==='sendTransaction').length,0);
});

test('signed bytes and pending state precede first send; uncertain restart broadcasts only the identical saved transaction',async t=>{
 const f=await withdrawalFixture(t);let signs=0;const signer=f.deps.signer;f.deps.signer={signTransaction:async bytes=>{signs++;return signer.signTransaction(bytes);}};f.restart();await reserve(f.k);
 const prepared=await f.k.prepareWithdrawal(1,'withdraw1'),sent=[],call=f.deps.rpc.call;
 f.deps.rpc.call=async(method,args)=>{if(method==='sendTransaction'){const read=new DatabaseSync(f.path);try{const row=read.prepare("SELECT state,receipt FROM ac_operations WHERE id='withdraw1'").get();assert.equal(row.state,'pending');assert.equal(JSON.parse(row.receipt).signed.signedTransaction,args[0]);}finally{read.close();}sent.push(args[0]);throw Error('ambiguous send timeout');}return call(method,args);};
 await f.k.broadcastWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'pending');f.restart({signer:null});
 await f.k.broadcastWithdrawal(1,'withdraw1');assert.deepEqual(sent,[prepared.signedTransaction,prepared.signedTransaction]);assert.equal(signs,1);assert.equal(f.k.balance(1).vaultAtoms,'9000');
 const db=new DatabaseSync(f.path);try{assert.throws(()=>db.prepare("UPDATE ac_operations SET payload='{}' WHERE id='withdraw1'").run(),/immutable/i);assert.throws(()=>db.prepare("UPDATE ac_operations SET receipt='{}' WHERE id='withdraw1'").run(),/immutable/i);}finally{db.close();}
});

test('finalized status alone and foreign raw bytes cannot settle or release; exact finalized failure releases once',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');
 f.deps.rpc.statuses.set(signed.signature,{slot:160,err:null,confirmationStatus:'finalized'});f.deps.rpc.slot=170;
 await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');
 const failed=finalized(f.deps,signed,{err:{InstructionError:[0,'InsufficientFunds']}});failed.transaction[0]=failed.transaction[0].slice(0,-4)+'AAAA';
 await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.balance(1).vaultAtoms,'9000');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');
 finalized(f.deps,signed,{err:{InstructionError:[0,'InsufficientFunds']}});await Promise.all([f.k.reconcileWithdrawal(1,'withdraw1'),f.k.reconcileWithdrawal(1,'withdraw1')]);
 assert.equal(f.k.withdrawal(1,'withdraw1').state,'failed');assert.equal(f.k.balance(1).vaultAtoms,'10000');assert.equal(f.k.totals().reserveAtoms,'10000');
});

test('expiry requires independently complete finalized history and never releases on pruned, contradictory or unavailable evidence',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const signed=await f.k.prepareWithdrawal(1,'withdraw1');
 f.deps.rpc.height=201;f.deps.rpc.valid=false;f.deps.archiveRpc.height=201;f.deps.archiveRpc.valid=false;
 f.deps.rpc.slot=250;f.deps.archiveRpc.slot=250;
 const original=f.deps.archiveRpc.call;
 for(const changed of [async(m,a)=>m==='getFirstAvailableBlock'?151:original(m,a),async(m,a)=>m==='getGenesisHash'?source:original(m,a),async(m,a)=>m==='getSignatureStatuses'?{context:{slot:170},value:[{slot:160,err:null,confirmationStatus:'confirmed'}]}:original(m,a),async(m,a)=>{if(m==='getTransaction')throw Error('archive unavailable');return original(m,a);}]){
  f.deps.archiveRpc.call=changed;await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'9000');
 }
 f.deps.archiveRpc.call=original;await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'expired');assert.equal(f.k.balance(1).vaultAtoms,'10000');
 await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.balance(1).vaultAtoms,'10000');
});

test('retained ledger blocks and two null transaction indexes cannot release without an explicit complete-block-window witness',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);await f.k.prepareWithdrawal(1,'withdraw1');
 for(const provider of [f.deps.rpc,f.deps.archiveRpc]){provider.height=201;provider.valid=false;provider.slot=250;}
 const complete=f.deps.archiveRpc.proveCompleteAbsence;
 f.deps.archiveRpc.proveCompleteAbsence=async()=>null;await f.k.reconcileWithdrawal(1,'withdraw1');
 assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'9000');
 for(const changed of [{sourceId:'other-provider'},{genesisHash:source},{signature:'foreign-signature'},{configHash:'0'.repeat(64)},{firstScannedHeight:101},{lastScannedHeight:199},{finalizedHeight:200},{absent:false}]){
  f.deps.archiveRpc.proveCompleteAbsence=async request=>({...await complete(request),...changed});await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');
 }
 f.deps.archiveRpc.proveCompleteAbsence=complete;await f.k.reconcileWithdrawal(1,'withdraw1');assert.equal(f.k.withdrawal(1,'withdraw1').state,'expired');assert.equal(f.k.balance(1).vaultAtoms,'10000');
});

test('the verified finalized blockhash origin is durable before signer invocation and mismatched origin blocks cannot authorize signing',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const call=f.deps.rpc.call,signer=f.deps.signer;let signs=0;
 f.deps.signer={signTransaction:async bytes=>{signs++;const read=new DatabaseSync(f.path);try{const record=JSON.parse(read.prepare("SELECT receipt FROM ac_operations WHERE id='withdraw1'").get().receipt);assert.equal(record.unsigned.blockhashOriginHeight,100);assert.equal(record.unsigned.blockhashSlot,150);assert.equal(record.signed,null);}finally{read.close();}return signer.signTransaction(bytes);}};f.restart();
 for(const bad of [{blockhash:source,blockHeight:100},{blockhash:null,blockHeight:100},{blockhash:'bad',blockHeight:null}]){
  f.deps.rpc.call=async(method,args)=>method==='getBlock'?bad:call(method,args);await assert.rejects(f.k.prepareWithdrawal(1,'withdraw1'));assert.equal(signs,0);
 }
 f.deps.rpc.call=call;await f.k.prepareWithdrawal(1,'withdraw1');assert.equal(signs,1);assert.equal(f.k.withdrawal(1,'withdraw1').blockhashOriginHeight,100);
});

test('solvency includes funded pools, world, escrow and reserved allocations, and shortfall never releases held claims',async t=>{
 const f=await withdrawalFixture(t);eventWorld(f.deps.world,f.config);f.k.fundPool({id:'pool',accountId:1,poolId:'rewards',atoms:'2000'});
 await f.k.prepareWorld({id:'world',accountId:1,guid:'10',kind:'grant',units:'20'});await f.k.advanceWorld(1,'world');
 await f.k.prepareEvent(quote({id:'mail',family:'mail-send',participants:[{accountId:1,guid:'10'}],escrows:[{id:'mail-hold',action:'create',kind:'mail',ownerAccountId:1,beneficiaryAccountId:2,retainedAccountId:1,expiresAt:0}],legs:[{id:'attachment',from:character(1,'10'),to:escrow('mail-hold'),units:'7'}]}));await f.k.advanceEvent(1,'mail');
 await reserve(f.k);f.deps.rpc.tokens.set(treasury,tokenInfo(f.config.treasuryWallet,'9500'));
 await assert.rejects(f.k.prepareWithdrawal(1,'withdraw1'));assert.equal(f.k.withdrawal(1,'withdraw1').state,'reserved');assert.equal(f.k.balance(1).vaultAtoms,'5000');assert.equal(f.k.pool('rewards').availableAtoms,'2000');assert.equal(f.k.escrow(1,'mail-hold').availableAtoms,'700');assert.equal(f.k.balance(1).worldAtoms,'1300');assert.equal(f.k.totals().claimsAtoms,'10000');
});

test('recovery listing is capped and paginated while account and operation formats cannot be substituted',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k,'b');await deposit(f.k,f.deps,{id:'dep2',accountId:2});await reserve(f.k,'a',2);
 const page=f.k.pendingWithdrawals({limit:1});assert.equal(page.entries[0].id,'a');assert.equal(page.nextCursor,'a');
 assert.equal(f.k.pendingWithdrawals({limit:1,afterId:page.nextCursor}).entries[0].id,'b');assert.throws(()=>f.k.pendingWithdrawals({limit:101}));
 await assert.rejects(f.k.advanceWorld(1,'b'));await assert.rejects(f.k.advanceEvent(1,'b'));assert.throws(()=>f.k.withdrawal(2,'b'));
});

test('a deposit confirmed while blockhash RPC awaits invalidates the old reserve proof before the signer is invoked',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);let release,ready,signs=0;
 const reached=new Promise(resolve=>ready=resolve),blocked=new Promise(resolve=>release=resolve),call=f.deps.rpc.call,signer=f.deps.signer;
 f.deps.signer={signTransaction:async bytes=>{signs++;return signer.signTransaction(bytes);}};f.restart();
 f.deps.rpc.call=async(method,args)=>{const value=await call(method,args);if(method==='getLatestBlockhash'){ready();await blocked;}return value;};
 const preparation=assert.rejects(f.k.prepareWithdrawal(1,'withdraw1'),/Stale|reserve/i);await reached;
 const intent=await f.k.createDeposit({accountId:2,id:'during-rpc',atoms:'1000',sourceTokenAccount:source}),{row,tx}=receipt(intent),signature=signatureOf(tx);
 row.slot=200;f.deps.rpc.slot=210;f.deps.rpc.tokens.set(treasury,tokenInfo(f.config.treasuryWallet,'18446744073709551615'));f.deps.rpc.receipts.set(signature,row);f.deps.rpc.statuses.set(signature,{slot:200,err:null,confirmationStatus:'finalized'});
 await f.k.confirmDeposit({accountId:2,id:'during-rpc',signature});release();await preparation;
 assert.equal(signs,0);assert.equal(f.k.withdrawal(1,'withdraw1').state,'reserved');assert.equal(f.k.totals().claimsAtoms,'11000');
});

test('another account finalized debit invalidates pre-debit reserve snapshots instead of signing against their old balance',async t=>{
 const f=await withdrawalFixture(t);await deposit(f.k,f.deps,{id:'dep2',accountId:2,amount:'2000'});await reserve(f.k,'first');const first=await f.k.prepareWithdrawal(1,'first');await reserve(f.k,'second',2);
 let release,ready,signs=0;const reached=new Promise(resolve=>ready=resolve),blocked=new Promise(resolve=>release=resolve),call=f.deps.rpc.call,signer=f.deps.signer;
 f.deps.signer={signTransaction:async bytes=>{signs++;return signer.signTransaction(bytes);}};f.restart();
 f.deps.rpc.call=async(method,args)=>{const value=await call(method,args);if(method==='getLatestBlockhash'){ready();await blocked;}return value;};
 const preparation=assert.rejects(f.k.prepareWithdrawal(2,'second'),/Stale|reserve/i);await reached;
 finalized(f.deps,first);await f.k.reconcileWithdrawal(1,'first');release();await preparation;
 assert.equal(signs,0);assert.equal(f.k.withdrawal(2,'second').state,'reserved');assert.equal(f.k.totals().claimsAtoms,'11000');
});

test('a finalized chain debit preceding local reconciliation freezes other signing without refunding either reservation',async t=>{
 const f=await withdrawalFixture(t);await deposit(f.k,f.deps,{id:'dep2',accountId:2,amount:'2000'});f.deps.rpc.tokens.set(treasury,tokenInfo(f.config.treasuryWallet,'12000'));
 await reserve(f.k,'first');const first=await f.k.prepareWithdrawal(1,'first');await reserve(f.k,'second',2);
 finalized(f.deps,first);f.deps.rpc.tokens.set(treasury,tokenInfo(f.config.treasuryWallet,'11000'));
 await assert.rejects(f.k.prepareWithdrawal(2,'second'),/reserve/i);assert.equal(f.k.withdrawal(1,'first').state,'signed');assert.equal(f.k.withdrawal(2,'second').state,'reserved');assert.equal(f.k.totals().claimsAtoms,'12000');
 await f.k.reconcileWithdrawal(1,'first');assert.equal((await f.k.prepareWithdrawal(2,'second')).state,'signed');assert.equal(f.k.totals().claimsAtoms,'11000');
});

test('a restarted wrong-network archive freezes signing and broadcast before either adapter can act',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);const wrong={...f.deps.archiveRpc,sourceId:'wrong-network-archive',call:async()=>source};
 f.restart({archiveRpc:wrong});await assert.rejects(f.k.prepareWithdrawal(1,'withdraw1'),/genesis|network/i);
 f.restart();await f.k.prepareWithdrawal(1,'withdraw1');f.restart({archiveRpc:wrong});
 await assert.rejects(f.k.broadcastWithdrawal(1,'withdraw1'),/genesis|network/i);assert.equal(f.deps.rpc.calls.filter(c=>c.method==='sendTransaction').length,0);
});

test('u64 withdrawals above signed SQLite range retain every atom in bytes, claims and terminal proof',async t=>{
 const f=await withdrawalFixture(t,{amount:'18446744073709551614'});await reserve(f.k,'large',1,'18446744073709551613');
 const signed=await f.k.prepareWithdrawal(1,'large'),tx=Transaction.from(Buffer.from(signed.signedTransaction,'base64'));
 assert.equal(tx.instructions[0].data.readBigUInt64LE(1),18446744073709551613n);assert.equal(f.k.balance(1).vaultAtoms,'1');
 finalized(f.deps,signed,{treasuryBefore:'18446744073709551614'});await f.k.reconcileWithdrawal(1,'large');
 assert.deepEqual(f.k.totals(),{reserveAtoms:'1',claimsAtoms:'1'});f.restart();assert.equal(f.k.withdrawal(1,'large').atoms,'18446744073709551613');
});

test('a concurrent deposit during sign-only adapter execution discards its result rather than persisting or sending it',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);let release,ready;const reached=new Promise(resolve=>ready=resolve),blocked=new Promise(resolve=>release=resolve),signer=f.deps.signer;
 f.deps.signer={signTransaction:async bytes=>{ready();await blocked;return signer.signTransaction(bytes);}};f.restart();
 const preparation=assert.rejects(f.k.prepareWithdrawal(1,'withdraw1'),/Stale|reserve/i);await reached;
 await deposit(f.k,f.deps,{id:'during-sign',accountId:2,amount:'1000'});release();await preparation;
 assert.equal(f.k.withdrawal(1,'withdraw1').signedTransaction,null);assert.equal(f.k.withdrawal(1,'withdraw1').state,'reserved');assert.equal(f.deps.rpc.calls.filter(c=>c.method==='sendTransaction').length,0);
});

test('a concurrent new chain proof while broadcast balance RPC awaits prevents submission of an old observation',async t=>{
 const f=await withdrawalFixture(t);await reserve(f.k);await f.k.prepareWithdrawal(1,'withdraw1');let release,ready;
 const reached=new Promise(resolve=>ready=resolve),blocked=new Promise(resolve=>release=resolve),call=f.deps.rpc.call;let pause=true;
 f.deps.rpc.call=async(method,args)=>{const value=await call(method,args);if(pause&&method==='getAccountInfo'&&args[0]===treasury){pause=false;ready();await blocked;}return value;};
 const sending=assert.rejects(f.k.broadcastWithdrawal(1,'withdraw1'),/Stale|reserve/i);await reached;
 const intent=await f.k.createDeposit({accountId:2,id:'during-broadcast',atoms:'1000',sourceTokenAccount:source}),{row,tx}=receipt(intent),signature=signatureOf(tx);
 row.slot=200;f.deps.rpc.slot=210;f.deps.rpc.tokens.set(treasury,tokenInfo(f.config.treasuryWallet,'18446744073709551615'));f.deps.rpc.receipts.set(signature,row);f.deps.rpc.statuses.set(signature,{slot:200,err:null,confirmationStatus:'finalized'});
 await f.k.confirmDeposit({accountId:2,id:'during-broadcast',signature});release();await sending;
 assert.equal(f.k.withdrawal(1,'withdraw1').state,'signed');assert.equal(f.deps.rpc.calls.filter(c=>c.method==='sendTransaction').length,0);
});
