import {PublicKey} from '@solana/web3.js';
import {configuration} from '../amounts.mjs';
import {createAccounting} from '../kernel.mjs';
import {input} from './fixtures.mjs';
import {withdrawalDependencies,reserve,treasury,tokenInfo} from './withdrawal-fixtures.mjs';
const [path,id,mode]=process.argv.slice(2),config=configuration(input),deps=withdrawalDependencies(config);
deps.rpc.tokens.set(treasury,tokenInfo(config.treasuryWallet,mode==='across'?'20000':'10000'));
const call=deps.rpc.call;
deps.rpc.call=async(method,args)=>method==='getLatestBlockhash'?{context:{slot:150},value:{blockhash:new PublicKey(Buffer.alloc(32,id==='a'?20:21)).toBase58(),lastValidBlockHeight:200}}:method==='getBlock'?{blockhash:new PublicKey(Buffer.alloc(32,id==='a'?20:21)).toBase58(),blockHeight:100}:call(method,args);
const k=createAccounting({path,config,...deps});process.send('ready');
process.once('message',async()=>{
 try{
  if(mode==='prepare'){
   await k.prepareWithdrawal(1,'shared');await k.broadcastWithdrawal(1,'shared');const row=k.withdrawal(1,'shared');
   process.send({ok:true,signature:row.signature,bytes:row.signedTransaction});
  }else{
   await reserve(k,mode==='same'?'shared':id,mode==='across'&&id==='b'?2:1,'7000');
   if(mode==='crash')process.exit(0);
   process.send({ok:true});
  }
 }catch(error){process.send({ok:false,error:error.message});}
 finally{k.close();process.disconnect();}
});
