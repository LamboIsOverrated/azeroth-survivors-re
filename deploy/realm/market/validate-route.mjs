import { AddressLookupTableAccount,AddressLookupTableProgram,PublicKey } from '@solana/web3.js';

const JUP='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOL='So11111111111111111111111111111111111111112';
const SYSTEM='11111111111111111111111111111111';
const COMPUTE='ComputeBudget111111111111111111111111111111';
const RAY='675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const BOOKS=new Set(['srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin']);
const EXECUTABLES=new Set([JUP,TOKEN,ATA,SYSTEM,COMPUTE,'675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8','srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX','9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin']);
const reject=()=>{throw new Error('Unsupported or unsafe wallet market route.');};
const requireThat=condition=>{if(!condition) reject();};
const equal=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const safeLamports=account=>{requireThat(account && Number.isSafeInteger(account.lamports) && account.lamports>=0);return BigInt(account.lamports);};
function dataOf(account) {requireThat(account && account.executable===false && Array.isArray(account.data) && account.data[1]==='base64' && typeof account.data[0]==='string');const data=Buffer.from(account.data[0],'base64');requireThat(data.toString('base64')===account.data[0]);return data;}
function token(account) {
  requireThat(account?.owner===TOKEN);const data=dataOf(account);requireThat(data.length===165 && data[108]===1);
  return {data,mint:new PublicKey(data.subarray(0,32)).toBase58(),owner:new PublicKey(data.subarray(32,64)).toBase58(),amount:data.readBigUInt64LE(64)};
}
const associated=(wallet,mint)=>PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(),new PublicKey(TOKEN).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey(ATA))[0].toBase58();
function sameTokenState(before,after) {return equal(before.data.subarray(0,64),after.data.subarray(0,64)) && equal(before.data.subarray(72),after.data.subarray(72));}

/**
 * Deliberately narrow audited envelope: Jupiter v6 route, one Raydium AMM v4 hop,
 * classic SPL, exact-in, zero platform fee. Unknown/new instructions fail closed.
 * IDL: https://github.com/jup-ag/jupiter-cpi/blob/main/idl.json
 * Simulation supplements the encoded onchain input/output/slippage checks.
 */
export async function validateRoute({tx,wallet,inputMint,outputMint,amount,quotedOutAmount,maxSlippageBps=100,rpc}) {
  requireThat(tx.version===0 && tx.message.header.numRequiredSignatures===1 && tx.message.staticAccountKeys[0]?.toBase58()===wallet);
  requireThat([inputMint,outputMint].filter(mint=>mint===SOL).length===1);
  const lookupTables=[];
  for(const lookup of tx.message.addressTableLookups) {
    const result=await rpc('getAccountInfo',[lookup.accountKey.toBase58(),{encoding:'base64',commitment:'confirmed'}]);
    const account=result.value;requireThat(account?.owner===AddressLookupTableProgram.programId.toBase58());
    const state=AddressLookupTableAccount.deserialize(dataOf(account));requireThat(state.deactivationSlot===18446744073709551615n);
    lookupTables.push(new AddressLookupTableAccount({key:lookup.accountKey,state}));
  }
  const resolved=tx.message.getAccountKeys({addressLookupTableAccounts:lookupTables});
  const keys=Array.from({length:resolved.length},(_,index)=>resolved.get(index).toBase58());
  requireThat(keys.length<=100 && new Set(keys).size===keys.length);
  const source=associated(wallet,inputMint),destination=associated(wallet,outputMint),native=associated(wallet,SOL);
  const buy=inputMint===SOL;let routes=0,funding=0,syncs=0,closes=0;const creations=new Set();let minimumOut,routeAccounts;
  for(const instruction of tx.message.compiledInstructions) {
    const program=keys[instruction.programIdIndex],accounts=instruction.accountKeyIndexes.map(index=>keys[index]),data=Buffer.from(instruction.data);
    requireThat(!accounts.includes(undefined));
    if(program===JUP) {
      requireThat(++routes===1 && data.length===35 && data.subarray(0,8).toString('hex')==='e517cb977ae3ad2a');
      // Borsh vec length 1; Swap::Raydium=7; 100% input index 0 -> output index 1.
      requireThat(data.readUInt32LE(8)===1 && equal(data.subarray(12,16),[7,100,0,1]));
      requireThat(data.readBigUInt64LE(16)===BigInt(amount) && data.readBigUInt64LE(24)===BigInt(quotedOutAmount));
      const slippage=data.readUInt16LE(32);requireThat(slippage<=maxSlippageBps && data[34]===0);
      minimumOut=BigInt(quotedOutAmount)*BigInt(10000-slippage)/10000n;requireThat(minimumOut>0n);
      const event=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],new PublicKey(JUP))[0].toBase58();
      requireThat(accounts.length===27 && accounts[0]===TOKEN && accounts[1]===wallet && accounts[2]===source && accounts[3]===destination && (accounts[4]===JUP || accounts[4]===destination) && accounts[5]===outputMint && accounts[6]===JUP && accounts[7]===event && accounts[8]===JUP);
      requireThat(accounts[9]===RAY && accounts[10]===TOKEN && BOOKS.has(accounts[16]) && accounts[24]===source && accounts[25]===destination && accounts[26]===wallet);routeAccounts=accounts;
    } else if(program===SYSTEM) {
      requireThat(buy && !routes && ++funding===1 && data.length===12 && data.readUInt32LE(0)===2 && data.readBigUInt64LE(4)===BigInt(amount) && accounts.length===2 && accounts[0]===wallet && accounts[1]===native);
    } else if(program===TOKEN) {
      if(data.length===1 && data[0]===17) requireThat(buy && !routes && funding===1 && ++syncs===1 && accounts.length===1 && accounts[0]===native);
      else if(data.length===1 && data[0]===9) requireThat(routes===1 && ++closes===1 && accounts.length===3 && accounts[0]===native && accounts[1]===wallet && accounts[2]===wallet);
      else reject(); // Includes Approve, SetAuthority, Transfer and arbitrary account closure.
    } else if(program===ATA) {
      requireThat(!routes && data.length<=1 && (data.length===0 || data[0]===1) && accounts.length>=6 && accounts[0]===wallet && accounts[2]===wallet && [inputMint,outputMint].includes(accounts[3]) && accounts[1]===associated(wallet,accounts[3]) && accounts[4]===SYSTEM && accounts[5]===TOKEN && !creations.has(accounts[1]));creations.add(accounts[1]);
    } else if(program===COMPUTE) {
      requireThat(!routes && accounts.length===0 && ((data.length===5 && data[0]===2 && data.readUInt32LE(1)<=1400000) || (data.length===9 && data[0]===3 && data.readBigUInt64LE(1)<=1000000n)));
    } else reject();
  }
  requireThat(routes===1 && closes===1 && (buy?funding===1 && syncs===1:funding===0 && syncs===0));
  const beforeResult=await rpc('getMultipleAccounts',[keys,{encoding:'base64',commitment:'confirmed'}]);
  requireThat(Number.isSafeInteger(beforeResult.context?.slot) && Array.isArray(beforeResult.value) && beforeResult.value.length===keys.length);
  const before=beforeResult.value,beforeMap=new Map(keys.map((key,index)=>[key,before[index]]));
  requireThat(beforeMap.get(JUP)?.executable===true && beforeMap.get(RAY)?.executable===true && beforeMap.get(TOKEN)?.executable===true && beforeMap.get(routeAccounts[16])?.executable===true);
  requireThat(beforeMap.get(routeAccounts[11])?.owner===RAY);
  for(const index of [13,17,18,19,20]) requireThat(beforeMap.get(routeAccounts[index])?.owner===routeAccounts[16]);
  for(const [first,second,ownerIndex] of [[14,15,12],[21,22,23]]) {
    const a=token(beforeMap.get(routeAccounts[first])),b=token(beforeMap.get(routeAccounts[second]));
    requireThat(new Set([a.mint,b.mint]).size===2 && [inputMint,outputMint].includes(a.mint) && [inputMint,outputMint].includes(b.mint) && a.owner===routeAccounts[ownerIndex] && b.owner===routeAccounts[ownerIndex]);
  }
  for(let index=0;index<keys.length;index++) {
    const account=before[index];if(account?.executable) requireThat(EXECUTABLES.has(keys[index]));
    if(!tx.message.isAccountWritable(index)) continue;
    if(account?.owner===TOKEN) {const parsed=token(account);if(parsed.owner===wallet) requireThat(keys[index]===source || keys[index]===destination);}
    // The supported DEX envelope contains classic SPL accounts only.
    if(account && account.owner==='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') reject();
  }
  requireThat(beforeMap.get(wallet)?.owner===SYSTEM && dataOf(beforeMap.get(wallet)).length===0);
  for(const [key,mint] of [[source,inputMint],[destination,outputMint]]) {
    const account=beforeMap.get(key);if(!account) {requireThat(creations.has(key));continue;}
    const parsed=token(account);requireThat(parsed.owner===wallet && parsed.mint===mint && parsed.data.readUInt32LE(72)===0 && parsed.data.readUInt32LE(129)===0);
    if(key===native) requireThat(parsed.amount===0n);
  }
  const feeResult=await rpc('getFeeForMessage',[Buffer.from(tx.message.serialize()).toString('base64'),{commitment:'confirmed'}]);
  requireThat(Number.isSafeInteger(feeResult.value) && feeResult.value>=0 && feeResult.value<=1000000);
  const fee=BigInt(feeResult.value);
  const simulated=await rpc('simulateTransaction',[Buffer.from(tx.serialize()).toString('base64'),{encoding:'base64',sigVerify:false,replaceRecentBlockhash:false,commitment:'confirmed',minContextSlot:beforeResult.context.slot,accounts:{encoding:'base64',addresses:keys}}]);
  requireThat(simulated.value?.err===null && Number.isSafeInteger(simulated.context?.slot) && simulated.context.slot>=beforeResult.context.slot && Array.isArray(simulated.value.accounts) && simulated.value.accounts.length===keys.length);
  const after=simulated.value.accounts,afterMap=new Map(keys.map((key,index)=>[key,after[index]]));
  requireThat(afterMap.get(wallet)?.owner===SYSTEM && dataOf(afterMap.get(wallet)).length===0 && afterMap.get(native)===null);
  for(let index=0;index<keys.length;index++) {
    if(!tx.message.isAccountWritable(index) || keys[index]===native) continue;
    const pre=before[index],post=after[index];
    if(pre?.owner===TOKEN && token(pre).owner===wallet) requireThat(post?.owner===TOKEN && sameTokenState(token(pre),token(post)));
    if(post?.owner===TOKEN && token(post).owner===wallet) {const parsed=token(post);requireThat((keys[index]===source || keys[index]===destination) && parsed.data.readUInt32LE(72)===0 && parsed.data.readUInt32LE(129)===0);}
  }
  const tokenKey=buy?destination:source,preToken=beforeMap.get(tokenKey),postToken=afterMap.get(tokenKey);
  requireThat(postToken?.owner===TOKEN);const post=token(postToken),pre=preToken?token(preToken):{amount:0n};
  requireThat(post.owner===wallet && post.mint===(buy?outputMint:inputMint));
  if(buy) requireThat(post.amount-pre.amount>=minimumOut);else requireThat(pre.amount-post.amount===BigInt(amount));
  // Wallet SOL plus rents across its two ATAs prevents hidden SOL charges or destinations.
  const walletTotal=map=>[wallet,source,destination].reduce((sum,key)=>sum+(map.get(key)?safeLamports(map.get(key)):0n),0n);
  const solDelta=walletTotal(afterMap)-walletTotal(beforeMap);
  if(buy) requireThat(solDelta===-BigInt(amount)-fee);else requireThat(solDelta+fee>=minimumOut);
  return {minimumOut:minimumOut.toString(),source,destination,networkFeeLamports:fee.toString()};
}
