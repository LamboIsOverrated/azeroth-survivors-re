import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {Transaction} from '@solana/web3.js';
import {configuration,gameAtoms} from '../amounts.mjs';
import {createAccounting} from '../kernel.mjs';
import {input as splInput} from './fixtures.mjs';
import {input,DEVNET_GENESIS,treasuryWallet,wallet,systemInfo,nativeRpc,nativeReceipt,nativeFixture,nativeDeposit,nativeReserve,nativeFinalized} from './native-sol-accounting-fixtures.mjs';
import {pairs,signFixture} from '../../../economy/settlement/tests/fixtures.mjs';
import {signatureOf} from '../../../economy/settlement/protocol.mjs';

test('native SOL config pins devnet, exact precision, explicit immutable scale and reserve floor without SPL fields',async t=>{
 const cfg=configuration(input);assert.equal(cfg.assetKind,'native-sol');assert.equal(cfg.cluster,'devnet');assert.equal(cfg.genesisHash,DEVNET_GENESIS);assert.equal(cfg.decimals,9);assert.equal(cfg.withdrawalFeePolicy,'gross-includes-network-fee');assert.equal(cfg.reserveFloorLamports,'10000');assert.equal(gameAtoms('100',cfg),'100000');assert.equal(cfg.mint,undefined);
 for(const changed of [{cluster:'mainnet-beta'},{genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'},{decimals:8},{namespaceId:'production-sol'},{reserveFloorLamports:undefined},{reserveFloorLamports:'0'},{mint:splInput.mint},{treasuryTokenAccount:splInput.treasuryTokenAccount},{atomsPerGameUnit:undefined}])assert.throws(()=>configuration({...input,...changed}));
 const f=await nativeFixture(t);assert.throws(()=>createAccounting({path:f.path,config:{...input,reserveFloorLamports:'10001'},...f.deps}),/immutable/i);assert.throws(()=>createAccounting({path:f.path,config:splInput,...f.deps}),/immutable/i);
});

test('native deposits prove exact finalized System transfer and credit once across restart without reading SPL',async t=>{
 const f=await nativeFixture(t,{fund:false}),proof=await nativeDeposit(f.k,f.deps);
 assert.equal(f.k.balance(1).vaultAtoms,'1000000');assert.deepEqual(f.k.totals(),{reserveAtoms:'1000000',claimsAtoms:'1000000'});await f.k.confirmDeposit({accountId:1,id:proof.intent.id,signature:proof.signature});f.restart();await f.k.confirmDeposit({accountId:1,id:proof.intent.id,signature:proof.signature});assert.equal(f.k.balance(1).vaultAtoms,'1000000');
 assert.equal(f.deps.rpc.calls.some(call=>call.method==='getAccountInfo'&&call.args[0]===undefined),false);await assert.rejects(f.k.confirmDeposit({accountId:2,id:proof.intent.id,signature:proof.signature}));assert.equal(proof.intent.destination,treasuryWallet);assert.equal(proof.intent.assetKind,'native-sol');
});

test('native deposit rejects reserve floor shortfall, wrong network, unsafe RPC lamports and non-System treasury',async t=>{
 for(const mode of ['floor','network','unsafe','program']){
  const f=await nativeFixture(t,{fund:false});
  const call=f.deps.rpc.call;f.deps.rpc.call=async(method,args)=>{const result=await call(method,args);if(method==='getGenesisHash'&&mode==='network')return wallet;if(method==='getAccountInfo'&&args[0]===treasuryWallet){if(mode==='floor')result.value=systemInfo(1000000);if(mode==='unsafe')result.value=systemInfo(Number.MAX_SAFE_INTEGER+1);if(mode==='program')result.value={...result.value,owner:wallet};}return result;};
  await assert.rejects(nativeDeposit(f.k,f.deps));assert.equal(f.k.balance(1).vaultAtoms,'0');
 }
});

test('native withdrawal gross debit persists fee/net before signing and successful payment conserves all claims',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);let signCalls=0;const signer=f.deps.signer;
 f.deps.signer={signTransaction:async bytes=>{signCalls++;const read=new DatabaseSync(f.path);try{const saved=JSON.parse(read.prepare("SELECT receipt FROM ac_operations WHERE id='native-withdraw'").get().receipt);assert.equal(saved.unsigned.feeLamports,'5000');assert.equal(saved.unsigned.netLamports,'95000');}finally{read.close();}return signer.signTransaction(bytes);}};f.restart();
 const signed=await f.k.prepareWithdrawal(1,'native-withdraw');assert.equal(signed.atoms,'100000');assert.equal(signed.feeLamports,'5000');assert.equal(signed.netLamports,'95000');assert.equal(Transaction.from(Buffer.from(signed.signedTransaction,'base64')).instructions[0].data.readBigUInt64LE(4),95000n);assert.equal(signCalls,1);
 nativeFinalized(f.deps,signed);const result=await f.k.reconcileWithdrawal(1,'native-withdraw');assert.equal(result.state,'settled');assert.equal(result.result.feeLamports,'5000');assert.equal(f.k.balance(1).vaultAtoms,'900000');assert.deepEqual(f.k.totals(),{reserveAtoms:'900000',claimsAtoms:'900000'});f.restart();await f.k.reconcileWithdrawal(1,'native-withdraw');assert.equal(f.k.balance(1).vaultAtoms,'900000');
});

test('a finalized native failure consumes only proven network fee and returns net reservation exactly once',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);const signed=await f.k.prepareWithdrawal(1,'native-withdraw');nativeFinalized(f.deps,signed,{err:{InstructionError:[0,'InsufficientFunds']}});
 const result=await f.k.reconcileWithdrawal(1,'native-withdraw');assert.equal(result.state,'failed');assert.equal(result.result.feeLamports,'5000');assert.equal(f.k.balance(1).vaultAtoms,'995000');assert.deepEqual(f.k.totals(),{reserveAtoms:'995000',claimsAtoms:'995000'});f.restart();await f.k.reconcileWithdrawal(1,'native-withdraw');assert.equal(f.k.balance(1).vaultAtoms,'995000');
});

test('invalid or unaffordable native fee quotes reject before claiming funds or locking the account',async t=>{
 for(const quote of [null,-1,0,1.2,Number.MAX_SAFE_INTEGER+1,100000,100001]){
  const f=await nativeFixture(t);f.deps.rpc.fee=quote;let signs=0;f.deps.signer={signTransaction:async()=>{signs++;throw Error('must not sign');}};f.restart();await assert.rejects(nativeReserve(f.k));assert.equal(signs,0);assert.throws(()=>f.k.withdrawal(1,'native-withdraw'),/Owned/i);assert.equal(f.k.balance(1).vaultAtoms,'1000000');assert.deepEqual(f.k.pendingWithdrawals().entries,[]);
  const read=new DatabaseSync(f.path);try{assert.equal(read.prepare("SELECT COUNT(*) n FROM ac_locks WHERE guid='account:1'").get().n,0);assert.equal(read.prepare("SELECT COUNT(*) n FROM ac_operations WHERE id='native-withdraw'").get().n,0);}finally{read.close();}
  f.restart();assert.equal(f.k.balance(1).vaultAtoms,'1000000');f.deps.rpc.fee=5000;assert.equal((await nativeReserve(f.k)).state,'reserved');
 }
 const f=await nativeFixture(t);const call=f.deps.rpc.call;f.deps.rpc.call=async(m,a)=>m==='getFeeForMessage'?{context:{slot:1},value:5000}:call(m,a);await assert.rejects(nativeReserve(f.k));assert.equal(f.k.balance(1).vaultAtoms,'1000000');assert.deepEqual(f.k.pendingWithdrawals().entries,[]);
});

test('gross native requests below or equal to the fee leave no claim or lock and accept a corrected retry',async t=>{
 for(const amount of ['1','5000']){
  const f=await nativeFixture(t);await assert.rejects(nativeReserve(f.k,{amount}),/fee/i);assert.equal(f.k.balance(1).vaultAtoms,'1000000');assert.throws(()=>f.k.withdrawal(1,'native-withdraw'));f.restart();assert.equal((await nativeReserve(f.k,{amount:'100000'})).state,'reserved');assert.equal(f.k.balance(1).vaultAtoms,'900000');
 }
});

test('native reserve atomically persists its exact fee plan and preparation reuses it across quote changes and restart',async t=>{
 const f=await nativeFixture(t),reserved=await nativeReserve(f.k);assert.equal(reserved.feeLamports,'5000');assert.equal(reserved.netLamports,'95000');
 const read=new DatabaseSync(f.path);try{const record=JSON.parse(read.prepare("SELECT receipt FROM ac_operations WHERE id='native-withdraw'").get().receipt);assert.equal(record.unsigned.feeLamports,'5000');assert.equal(record.unsigned.netLamports,'95000');assert.equal(record.signed,null);}finally{read.close();}
 const quoted=f.deps.rpc.calls.filter(call=>call.method==='getFeeForMessage').length;f.deps.rpc.fee=9000;f.restart();assert.equal((await nativeReserve(f.k)).feeLamports,'5000');const signed=await f.k.prepareWithdrawal(1,'native-withdraw');assert.equal(signed.feeLamports,'5000');assert.equal(signed.netLamports,'95000');assert.equal(f.deps.rpc.calls.filter(call=>call.method==='getFeeForMessage').length,quoted);
});

test('competing native reservations choose one immutable fee plan before either caller can hold additional funds',async t=>{
 const f=await nativeFixture(t),rpc=nativeRpc();rpc.fee=7000;rpc.accounts.set(treasuryWallet,systemInfo(1010000));const other=createAccounting({path:f.path,config:f.config,...f.deps,rpc});
 try{const [a,b]=await Promise.all([nativeReserve(f.k),nativeReserve(other)]);assert.equal(a.feeLamports,b.feeLamports);assert.equal(a.netLamports,b.netLamports);assert.ok(['5000','7000'].includes(a.feeLamports));assert.equal(BigInt(a.feeLamports)+BigInt(a.netLamports),100000n);assert.equal(f.k.balance(1).vaultAtoms,'900000');assert.equal(f.k.pendingWithdrawals().entries.length,1);}finally{other.close();}
});

test('wrong fee or fee-only failure balance contradiction keeps native claim reserved',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);const signed=await f.k.prepareWithdrawal(1,'native-withdraw');
 nativeFinalized(f.deps,signed,{fee:6000});assert.equal((await f.k.reconcileWithdrawal(1,'native-withdraw')).state,'signed');
 const row=nativeFinalized(f.deps,signed,{err:{InstructionError:[0,'InsufficientFunds']}});row.meta.postBalances[0]--;assert.equal((await f.k.reconcileWithdrawal(1,'native-withdraw')).state,'signed');assert.equal(f.k.balance(1).vaultAtoms,'900000');
});

test('ambiguous native broadcast survives restart and reuses signed bytes without a second fee or signature',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);const signed=await f.k.prepareWithdrawal(1,'native-withdraw');f.deps.rpc.failSend=true;await f.k.broadcastWithdrawal(1,'native-withdraw');f.restart({signer:null});await f.k.broadcastWithdrawal(1,'native-withdraw');const sends=f.deps.rpc.calls.filter(call=>call.method==='sendTransaction');assert.equal(sends.length,2);assert.ok(sends.every(call=>call.args[0]===signed.signedTransaction));assert.equal(f.k.withdrawal(1,'native-withdraw').state,'pending');assert.equal(f.k.balance(1).vaultAtoms,'900000');
 for(const provider of [f.deps.rpc,f.deps.archiveRpc]){provider.slot=250;provider.height=201;provider.valid=false;}assert.equal((await f.k.reconcileWithdrawal(1,'native-withdraw')).state,'expired');assert.equal(f.k.balance(1).vaultAtoms,'1000000');assert.deepEqual(f.k.totals(),{reserveAtoms:'1000000',claimsAtoms:'1000000'});
});

test('native reserve floor and destination ownership cannot be bypassed by token-style destinations',async t=>{
 const f=await nativeFixture(t);await assert.rejects(f.k.reserveWithdrawal({accountId:1,id:'foreign',atoms:'100000',destinationWallet:treasuryWallet}));await assert.rejects(f.k.reserveWithdrawal({accountId:1,id:'token',atoms:'100000',destinationTokenAccount:wallet}));
 await nativeReserve(f.k);f.deps.rpc.accounts.set(treasuryWallet,systemInfo(1009999));await assert.rejects(f.k.prepareWithdrawal(1,'native-withdraw'),/reserve|floor/i);assert.equal(f.k.withdrawal(1,'native-withdraw').state,'reserved');
});

test('native deposit proof advancing during asynchronous signing discards the stale signature',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);let release,ready;const reached=new Promise(resolve=>ready=resolve),blocked=new Promise(resolve=>release=resolve),signer=f.deps.signer;
 f.deps.signer={signTransaction:async bytes=>{ready();await blocked;return signer.signTransaction(bytes);}};f.restart();const preparation=assert.rejects(f.k.prepareWithdrawal(1,'native-withdraw'),/Stale|reserve/i);await reached;await nativeDeposit(f.k,f.deps,{id:'during-native-sign',accountId:2,amount:'1000',slot:200});release();await preparation;assert.equal(f.k.withdrawal(1,'native-withdraw').signedTransaction,null);
});

test('a later finalized withdrawal invalidates an older native reserve read before another deposit can credit',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);const signed=await f.k.prepareWithdrawal(1,'native-withdraw');
 const intent=await f.k.createDeposit({accountId:2,id:'overlapping-native-deposit',atoms:'1000'}),{row,tx}=nativeReceipt({owner:wallet,destination:treasuryWallet,lamports:'1000',memo:intent.memo,treasuryBefore:1010000}),signature=signatureOf(tx);
 f.deps.rpc.statuses.set(signature,{slot:row.slot,err:null,confirmationStatus:'finalized'});f.deps.rpc.receipts.set(signature,row);f.deps.rpc.accounts.set(treasuryWallet,systemInfo(1011000));
 let release,ready;const reached=new Promise(resolve=>ready=resolve),blocked=new Promise(resolve=>release=resolve),call=f.deps.rpc.call;let pause=true;
 f.deps.rpc.call=async(m,a)=>{const result=await call(m,a);if(pause&&m==='getAccountInfo'&&a[0]===treasuryWallet){pause=false;ready();await blocked;}return result;};
 const confirmation=assert.rejects(f.k.confirmDeposit({accountId:2,id:intent.id,signature}),/Stale|reserve/i);await reached;nativeFinalized(f.deps,signed);await f.k.reconcileWithdrawal(1,'native-withdraw');release();await confirmation;assert.equal(f.k.balance(2).vaultAtoms,'0');assert.equal(f.k.totals().claimsAtoms,'900000');
});

test('native signer cannot substitute net amount, memo or blockhash, and immutable fee plan survives retries',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);
 for(const change of [tx=>tx.instructions[0].data.writeBigUInt64LE(95001n,4),tx=>tx.instructions[1].data=Buffer.from('other memo'),tx=>tx.recentBlockhash=wallet]){
  f.deps.signer={signTransaction:async bytes=>{const tx=Transaction.from(bytes);change(tx);return signFixture(tx,pairs[0]).serialize();}};f.restart();await assert.rejects(f.k.prepareWithdrawal(1,'native-withdraw'),/Signer|exact/i);assert.equal(f.k.withdrawal(1,'native-withdraw').state,'reserved');assert.equal(f.k.withdrawal(1,'native-withdraw').feeLamports,'5000');
 }
 assert.equal(f.deps.rpc.calls.filter(call=>call.method==='sendTransaction').length,0);
});

test('native concurrent preparations retain one immutable gross/fee/net payment identity',async t=>{
 const f=await nativeFixture(t);await nativeReserve(f.k);const other=createAccounting({path:f.path,config:f.config,...f.deps});
 try{const [a,b]=await Promise.all([f.k.prepareWithdrawal(1,'native-withdraw'),other.prepareWithdrawal(1,'native-withdraw')]);assert.equal(a.signature,b.signature);assert.equal(a.signedTransaction,b.signedTransaction);assert.equal(a.netLamports,'95000');assert.equal(a.feeLamports,'5000');assert.equal(f.k.totals().claimsAtoms,'1000000');}finally{other.close();}
});
