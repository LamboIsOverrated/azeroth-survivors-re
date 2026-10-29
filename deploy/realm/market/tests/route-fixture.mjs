import { PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction } from '@solana/web3.js';
export const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SOL='So11111111111111111111111111111111111111112';
export const RAY='675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const BOOK='srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX';
export function ata(wallet,mint) {return PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(),new PublicKey(TOKEN).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey(ATA))[0];}
export function tokenAccount(wallet,mint,amount=0n) {
  const data=Buffer.alloc(165);new PublicKey(mint).toBuffer().copy(data,0);new PublicKey(wallet).toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;
  if(mint===SOL){data.writeUInt32LE(1,109);data.writeBigUInt64LE(2039280n,113);}
  return {owner:TOKEN,lamports:2039280+(mint===SOL?Number(amount):0),executable:false,data:[data.toString('base64'),'base64']};
}
export function routeFixture(wallet,mint,amount='1',direction='sol-to-token',{badInput,badDestination,extraInstructions=[],badSlippage,badMinimum}={}) {
  const buy=direction==='sol-to-token',inputMint=buy?SOL:mint,outputMint=buy?mint:SOL;
  const source=ata(wallet,inputMint),destination=ata(wallet,outputMint),native=ata(wallet,SOL);
  const key=(pubkey,isWritable=false,isSigner=false)=>({pubkey:new PublicKey(pubkey),isWritable,isSigner});
  const data=Buffer.alloc(35);Buffer.from('e517cb977ae3ad2a','hex').copy(data);data.writeUInt32LE(1,8);data[12]=7;data[13]=100;data[14]=0;data[15]=1;data.writeBigUInt64LE(BigInt(badInput??amount),16);data.writeBigUInt64LE(2000000n,24);data.writeUInt16LE(badSlippage??100,32);data[34]=0;
  const event=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],new PublicKey(JUP))[0];
  const poolKeys=Array.from({length:12},(_,index)=>new PublicKey(new Uint8Array(32).fill(180+index)));
  const route=new TransactionInstruction({programId:new PublicKey(JUP),data,keys:[key(TOKEN),key(wallet,false,true),key(source,true),key(badDestination??destination,true),key(JUP),key(outputMint),key(JUP),key(event),key(JUP),key(RAY),key(TOKEN),key(poolKeys[0],true),key(poolKeys[1]),key(poolKeys[2],true),key(poolKeys[3],true),key(poolKeys[4],true),key(BOOK),key(poolKeys[5],true),key(poolKeys[6],true),key(poolKeys[7],true),key(poolKeys[8],true),key(poolKeys[9],true),key(poolKeys[10],true),key(poolKeys[11]),key(source,true),key(destination,true),key(wallet,false,true)]});
  const instructions=[];
  if(buy) {
    const funding=Buffer.alloc(12);funding.writeUInt32LE(2);funding.writeBigUInt64LE(BigInt(amount),4);
    instructions.push(new TransactionInstruction({programId:PublicKey.default,keys:[key(wallet,true,true),key(native,true)],data:funding}),new TransactionInstruction({programId:new PublicKey(TOKEN),keys:[key(native,true)],data:Buffer.from([17])}));
  }
  instructions.push(route,...extraInstructions,new TransactionInstruction({programId:new PublicKey(TOKEN),keys:[key(native,true),key(wallet,true),key(wallet,false,true)],data:Buffer.from([9])}));
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(wallet),recentBlockhash:PublicKey.default.toBase58(),instructions}).compileToV0Message());
  const before=new Map([[wallet,{owner:PublicKey.default.toBase58(),lamports:1000000000000,executable:false,data:['','base64']}],[source.toBase58(),tokenAccount(wallet,inputMint,buy?0n:BigInt(amount))],[destination.toBase58(),tokenAccount(wallet,outputMint)]]);
  for(const program of [JUP,RAY,TOKEN,BOOK]) before.set(program,{owner:'BPFLoaderUpgradeab1e11111111111111111111111',lamports:1,executable:true,data:['','base64']});
  const poolAccount=owner=>({owner,lamports:2039280,executable:false,data:[Buffer.alloc(752).toString('base64'),'base64']});
  before.set(poolKeys[0].toBase58(),poolAccount(RAY));
  before.set(poolKeys[2].toBase58(),poolAccount(BOOK));
  for(const index of [5,6,7,8]) before.set(poolKeys[index].toBase58(),poolAccount(BOOK));
  before.set(poolKeys[3].toBase58(),tokenAccount(poolKeys[1].toBase58(),inputMint,3000000n));before.set(poolKeys[4].toBase58(),tokenAccount(poolKeys[1].toBase58(),outputMint,3000000n));
  before.set(poolKeys[9].toBase58(),tokenAccount(poolKeys[11].toBase58(),inputMint,3000000n));before.set(poolKeys[10].toBase58(),tokenAccount(poolKeys[11].toBase58(),outputMint,3000000n));
  const after=new Map(before);after.set(native.toBase58(),null);
  after.set(wallet,{...before.get(wallet),lamports:1000000000000-5000+2039280+(buy?-Number(BigInt(amount)):2000000)});
  if(buy) after.set(destination.toBase58(),tokenAccount(wallet,mint,BigInt(badMinimum??2000000)));
  else after.set(source.toBase58(),tokenAccount(wallet,mint,0n));
  return {tx,before,after,minimumOut:'1980000'};
}
