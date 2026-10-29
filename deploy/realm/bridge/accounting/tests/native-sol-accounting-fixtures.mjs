import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey,Transaction,SystemProgram,TransactionInstruction} from '@solana/web3.js';
import {configuration,hash} from '../amounts.mjs';
import {createAccounting} from '../kernel.mjs';
import {pairs,signFixture,blockhash,NOW,MEMO,fixtureSigner} from '../../../economy/settlement/tests/fixtures.mjs';
import {signatureOf} from '../../../economy/settlement/protocol.mjs';
import {worldFixture} from './fixtures.mjs';

export const DEVNET_GENESIS='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const treasuryWallet=pairs[0].publicKey.toBase58(),wallet=pairs[1].publicKey.toBase58();
export const input={phase:'LIVE',assetKind:'native-sol',cluster:'devnet',namespaceId:'devnet-sol-accounting-fixture',genesisHash:DEVNET_GENESIS,decimals:9,treasuryWallet,atomsPerGameUnit:'1000',reserveFloorLamports:'10000'};
export const systemInfo=(lamports=0)=>({owner:SystemProgram.programId.toBase58(),executable:false,data:['','base64'],lamports});
function transfer(owner,destination,lamports,memo,recentBlockhash=blockhash){return new Transaction({feePayer:new PublicKey(owner),recentBlockhash}).add(SystemProgram.transfer({fromPubkey:new PublicKey(owner),toPubkey:new PublicKey(destination),lamports:BigInt(lamports)}),new TransactionInstruction({programId:new PublicKey(MEMO),keys:[],data:Buffer.from(memo)}));}
export function nativeReceipt({owner,destination,lamports,memo,signer=pairs[1],fee=5000,err=null,slot=160,raw=null,treasuryBefore=null}){
 const tx=raw?Transaction.from(Buffer.from(raw,'base64')):signFixture(transfer(owner,destination,lamports,memo),signer),keys=tx.compileMessage().accountKeys.map(key=>key.toBase58());
 const pre=keys.map(key=>key===owner?(owner===treasuryWallet?(treasuryBefore??1010000):1000000000):key===destination?(destination===treasuryWallet?(treasuryBefore??10000):0):1);
 const post=pre.map((n,index)=>keys[index]===owner?n-fee-(err?0:Number(lamports)):keys[index]===destination?n+(err?0:Number(lamports)):n);
 return {row:{slot,blockTime:NOW/1000,version:'legacy',transaction:[tx.serialize().toString('base64'),'base64'],meta:{err,fee,innerInstructions:[],preTokenBalances:[],postTokenBalances:[],preBalances:pre,postBalances:post}},tx};
}
export function nativeRpc(){
 const rpc={sourceId:'native-primary-fixture',slot:170,height:150,valid:true,fee:5000,genesis:DEVNET_GENESIS,accounts:new Map([[treasuryWallet,systemInfo(10000)],[wallet,systemInfo(1000000000)]]),statuses:new Map(),receipts:new Map(),calls:[],sendResult:null,failSend:false};
 rpc.call=async(method,args=[])=>{
  rpc.calls.push({method,args});
  if(method==='getGenesisHash')return rpc.genesis;
  if(method==='getAccountInfo')return {context:{slot:rpc.slot},value:rpc.accounts.get(args[0])??null};
  if(method==='getSlot')return 100;
  if(method==='getSignatureStatuses')return {context:{slot:rpc.slot},value:args[0].map(signature=>rpc.statuses.get(signature)??null)};
  if(method==='getTransaction')return rpc.receipts.get(args[0])??null;
  if(method==='getLatestBlockhash')return {context:{slot:rpc.slot},value:{blockhash,lastValidBlockHeight:200}};
  if(method==='getBlock')return {blockhash,blockHeight:100};
  if(method==='getFeeForMessage')return {context:{slot:rpc.slot},value:rpc.fee};
  if(method==='getBlockHeight')return rpc.height;
  if(method==='isBlockhashValid')return {context:{slot:rpc.slot},value:rpc.valid};
  if(method==='getFirstAvailableBlock')return 0;
  if(method==='sendTransaction'){if(rpc.failSend)throw Error('ambiguous send');return rpc.sendResult;}
  throw Error('Unexpected native fixture RPC '+method);
 };return rpc;
}
export async function nativeDeposit(k,deps,{id='native-deposit',accountId=1,amount='1000000',slot=160}={}){
 const before=deps.rpc.accounts.get(treasuryWallet).lamports,intent=await k.createDeposit({accountId,id,atoms:amount}),{row,tx}=nativeReceipt({owner:wallet,destination:treasuryWallet,lamports:amount,memo:intent.memo,slot,treasuryBefore:before}),signature=signatureOf(tx);
 deps.rpc.receipts.set(signature,row);deps.rpc.statuses.set(signature,{slot,err:null,confirmationStatus:'finalized'});deps.rpc.slot=Math.max(deps.rpc.slot,slot);deps.rpc.accounts.set(treasuryWallet,systemInfo(Number(amount)+before));
 await k.confirmDeposit({accountId,id,signature});return {intent,row,signature};
}
export async function nativeFixture(t,{amount='1000000',fund=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'native-sol-accounting-')),path=join(dir,'devnet-sol.sqlite'),config=configuration(input),rpc=nativeRpc(),archiveRpc=nativeRpc();
 archiveRpc.sourceId='native-independent-archive';archiveRpc.completenessPolicyId='native-offline-complete-block-fixture-v1';
 archiveRpc.proveCompleteAbsence=async request=>({kind:'complete-finalized-block-window-v1',sourceId:archiveRpc.sourceId,policyId:archiveRpc.completenessPolicyId,genesisHash:config.genesisHash,namespaceId:config.namespaceId,configHash:config.hash,signature:request.signature,blockhash:request.blockhash,lastValidBlockHeight:request.lastValidBlockHeight,blockhashOriginSlot:request.blockhashSlot,blockhashOriginHeight:request.blockhashOriginHeight,firstScannedHeight:request.blockhashOriginHeight,lastScannedHeight:request.lastValidBlockHeight,finalizedSlot:archiveRpc.slot,finalizedHeight:archiveRpc.height,absent:true,evidenceHash:hash('native-complete-window:'+request.signature)});
 const deps={rpc,archiveRpc,signer:fixtureSigner,resolveWallet:async()=>wallet,world:worldFixture(config),clock:()=>NOW};let kernel=createAccounting({path,config,...deps});
 t.after(()=>{kernel.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 if(fund)await nativeDeposit(kernel,deps,{amount});
 return {path,config,deps,get k(){return kernel;},restart(overrides={}){kernel.close();kernel=createAccounting({path,config,...deps,...overrides});}};
}
export const nativeReserve=(k,{id='native-withdraw',accountId=1,amount='100000'}={})=>k.reserveWithdrawal({accountId,id,atoms:amount,destinationWallet:wallet});
export function nativeFinalized(deps,signed,{err=null,fee=5000,slot=180,treasuryBefore=1010000}={}){
 const {row}=nativeReceipt({owner:treasuryWallet,destination:wallet,lamports:signed.netLamports,memo:signed.memo,raw:signed.signedTransaction,err,fee,slot,treasuryBefore});
 deps.rpc.slot=Math.max(deps.rpc.slot,slot);deps.rpc.statuses.set(signed.signature,{slot,err,confirmationStatus:'finalized'});deps.rpc.receipts.set(signed.signature,row);return row;
}
