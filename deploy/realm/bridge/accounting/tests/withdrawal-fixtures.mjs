import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Transaction} from '@solana/web3.js';
import {configuration,hash} from '../amounts.mjs';
import {createAccounting} from '../kernel.mjs';
import {input,dependencies,deposit} from './fixtures.mjs';
import {fakeRpc,fixtureSigner,tokenInfo,treasury,destination,mint,blockhash,config as chain,TOKEN,NOW} from '../../../economy/settlement/tests/fixtures.mjs';
export {destination,treasury,tokenInfo};

export function withdrawalDependencies(config){
 const deps=dependencies(config);deps.archiveRpc=fakeRpc();deps.archiveRpc.sourceId='independent-archive-fixture';deps.archiveRpc.completenessPolicyId='offline-complete-block-fixture-v1';
 const call=deps.rpc.call;deps.rpc.call=async(method,args)=>method==='getBlock'?{blockhash,blockHeight:100}:call(method,args);
 deps.archiveRpc.proveCompleteAbsence=async request=>({kind:'complete-finalized-block-window-v1',sourceId:deps.archiveRpc.sourceId,policyId:deps.archiveRpc.completenessPolicyId,genesisHash:config.genesisHash,namespaceId:config.namespaceId,configHash:config.hash,signature:request.signature,blockhash:request.blockhash,lastValidBlockHeight:request.lastValidBlockHeight,blockhashOriginSlot:request.blockhashSlot,blockhashOriginHeight:request.blockhashOriginHeight,firstScannedHeight:request.blockhashOriginHeight,lastScannedHeight:request.lastValidBlockHeight,finalizedSlot:deps.archiveRpc.slot,finalizedHeight:deps.archiveRpc.height,absent:true,evidenceHash:hash('offline-complete-window:'+request.signature)});
 deps.signer=fixtureSigner;return deps;
}
export async function withdrawalFixture(t,{amount='10000'}={}){
 const dir=mkdtempSync(join(tmpdir(),'conserved-withdrawal-')),path=join(dir,'live.sqlite'),config=configuration(input),deps=withdrawalDependencies(config);
 let kernel=createAccounting({path,config,...deps});await deposit(kernel,deps,{amount});deps.rpc.tokens.set(treasury,tokenInfo(config.treasuryWallet,amount));
 t.after(()=>{kernel.close();rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 return {path,config,deps,get k(){return kernel;},restart(overrides={}){kernel.close();kernel=createAccounting({path,config,...deps,...overrides});}};
}
export const reserve=(k,id='withdraw1',accountId=1,atoms='1000')=>k.reserveWithdrawal({accountId,id,atoms,destinationTokenAccount:destination});
export function withdrawalReceipt(withdrawal,{err=null,slot=160,treasuryBefore='10000'}={}){
 const tx=Transaction.from(Buffer.from(withdrawal.signedTransaction,'base64')),keys=tx.compileMessage().accountKeys.map(k=>k.toBase58()),amount=BigInt(withdrawal.atoms);
 const balance=(account,owner,value)=>({accountIndex:keys.indexOf(account),mint,owner,programId:TOKEN,uiTokenAmount:{amount:String(value),decimals:chain.decimals}});
 return {slot,blockTime:NOW/1000,version:'legacy',transaction:[withdrawal.signedTransaction,'base64'],meta:{err,innerInstructions:[],preTokenBalances:[balance(treasury,chain.treasuryWallet,BigInt(treasuryBefore)),balance(destination,withdrawal.wallet,0n)],postTokenBalances:[balance(treasury,chain.treasuryWallet,err?BigInt(treasuryBefore):BigInt(treasuryBefore)-amount),balance(destination,withdrawal.wallet,err?0n:amount)]}};
}
export function finalized(deps,withdrawal,options={}){const row=withdrawalReceipt(withdrawal,options);deps.rpc.slot=Math.max(deps.rpc.slot,row.slot);deps.rpc.statuses.set(withdrawal.signature,{slot:row.slot,err:row.meta.err,confirmationStatus:'finalized'});deps.rpc.receipts.set(withdrawal.signature,row);return row;}
