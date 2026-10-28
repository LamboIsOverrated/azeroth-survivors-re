import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { validateRoute } from './validate-route.mjs';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2dN';
const JUPITER = 'https://api.jup.ag/swap/v2';
const U64_MAX = 18446744073709551615n;
const fail = (status, message) => Object.assign(new Error(message), {status});
const hash = value => createHash('sha256').update(value).digest('hex');
const atoms = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= U64_MAX;
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value; } catch { return false; } };
function send(res, status, data) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'private, no-store',pragma:'no-cache','x-content-type-options':'nosniff',vary:'Cookie, Origin'});
  res.end(JSON.stringify(data));return true;
}
async function body(req) {
  const chunks=[];let size=0;
  for await(const chunk of req) { size+=chunk.length;if(size>16384) throw fail(413,'Request too large.');chunks.push(chunk); }
  let result;try {result=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw fail(400,'Invalid JSON request.');}
  if(!result || typeof result!=='object' || Array.isArray(result)) throw fail(400,'A JSON object is required.');
  return result;
}
function onlyKeys(input, keys) { if(Object.keys(input).some(key=>!keys.includes(key))) throw fail(400,'Unexpected request field.'); }
function transaction(base64) {
  if(typeof base64!=='string' || base64.length>8192 || base64.length%4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw fail(400,'Invalid transaction.');
  try {
    const bytes=Buffer.from(base64,'base64');if(bytes.toString('base64')!==base64 || bytes.length>1232) throw new Error();
    const tx=VersionedTransaction.deserialize(bytes);
    if(tx.version!==0 || !Buffer.from(tx.serialize()).equals(bytes)) throw new Error();
    return tx;
  } catch {throw fail(400,'Invalid version 0 transaction.');}
}
function base58(bytes) {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let value=BigInt(`0x${Buffer.from(bytes).toString('hex')}`);let result='';
  while(value) {result=alphabet[Number(value%58n)]+result;value/=58n;}
  for(const byte of bytes) {if(byte!==0) break;result='1'+result;}return result;
}
function settings(env) {
  let origin;try {origin=new URL(env.PUBLIC_ORIGIN);} catch {throw new Error('PUBLIC_ORIGIN is required for the market.');}
  if(origin.origin!==env.PUBLIC_ORIGIN || (origin.protocol!=='https:' && !(origin.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))) throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin.');
  const primary=env.ECONOMY_TOKEN_MINT || null, fallback=env.GAME_TOKEN_MINT || null;
  const mint=primary || fallback;
  const symbol=env.ECONOMY_TOKEN_SYMBOL || env.GAME_TOKEN_SYMBOL || 'TOKEN';
  const expected=env.ECONOMY_TOKEN_DECIMALS ?? env.GAME_TOKEN_DECIMALS;
  const slippage=env.MARKET_MAX_SLIPPAGE_BPS ?? '100';
  let reason=null;
  if(!mint) reason='Exchange opens after the launch token contract is configured.';
  else if(!address(mint) || mint===SOL_MINT || (primary && fallback && primary!==fallback)) reason='Launch token configuration is invalid or conflicting.';
  else if(env.TOKEN_LAUNCHED!=='true' || env.SWAPS_ENABLED!=='true') reason='Exchange opens after token launch and market activation.';
  else if(env.SOLANA_CLUSTER && env.SOLANA_CLUSTER!=='mainnet-beta') reason='The exchange requires Solana mainnet.';
  else if(expected!==undefined && (!/^\d{1,3}$/.test(expected) || Number(expected)>255)) reason='Token decimals configuration is invalid.';
  else if(env.ECONOMY_TOKEN_DECIMALS!==undefined && env.GAME_TOKEN_DECIMALS!==undefined && env.ECONOMY_TOKEN_DECIMALS!==env.GAME_TOKEN_DECIMALS) reason='Token decimals configuration is conflicting.';
  else if(!/^\d{1,3}$/.test(slippage) || Number(slippage)>100) reason='Market slippage limit must be between 0 and 100 basis points.';
  const endpoint=env.ECONOMY_SOLANA_RPC_URL || env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
  let rpc;try {rpc=new URL(endpoint);if(rpc.protocol!=='https:' || rpc.username || rpc.password || rpc.hash) throw new Error();} catch {reason='A trusted HTTPS Solana RPC endpoint is required.';}
  return {origin:origin.origin,mint:address(mint)?mint:null,symbol:/^[A-Za-z0-9]{1,12}$/.test(symbol)?symbol:'TOKEN',expected:expected===undefined?null:Number(expected),maxSlippageBps:Number(slippage),rpc:rpc?.href,reason};
}

/** Noncustodial wallet market. Identity and wallet binding are always resolved by the realm. */
export function createMarket({identity,resolveWallet,env=process.env,fetchImpl=globalThis.fetch,now=Date.now}={}) {
  if(typeof identity!=='function' || typeof resolveWallet!=='function') throw new Error('Realm identity and verified wallet providers are required.');
  const config=settings(env),orders=new Map(),rates=new Map();let validation=null,validationUntil=0,validating=null;
  const headers={'content-type':'application/json',...(env.JUPITER_API_KEY?{'x-api-key':env.JUPITER_API_KEY}:{})};
  async function upstream(url,options={}) {
    const response=await fetchImpl(url,{...options,signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!response.ok) throw new Error('Upstream unavailable');
    return response.json();
  }
  async function rpc(method,params=[]) {
    const result=await upstream(config.rpc,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    if(result.error || result.result===undefined) throw new Error('RPC unavailable');return result.result;
  }
  async function validated() {
    if(config.reason) return {enabled:false,reason:config.reason,tokenDecimals:null};
    if(validation && validationUntil>now()) return validation;
    if(validating) return validating;
    validating=(async()=>{
      try {
        if(await rpc('getGenesisHash')!==MAINNET_GENESIS) throw new Error();
        const account=(await rpc('getAccountInfo',[config.mint,{encoding:'base64',commitment:'finalized'}])).value;
        if(!account || account.owner!==TOKEN_PROGRAM || account.executable!==false || !Array.isArray(account.data) || account.data[1]!=='base64' || typeof account.data[0]!=='string') throw new Error();
        const data=Buffer.from(account.data[0],'base64');
        if(data.length!==82 || data.toString('base64')!==account.data[0] || data[45]!==1 || (config.expected!==null && config.expected!==data[44])) throw new Error();
        validation={enabled:true,reason:null,tokenDecimals:data[44]};validationUntil=now()+30000;
      } catch {validation={enabled:false,reason:'Launch token could not be verified on Solana mainnet. Exchange is closed.',tokenDecimals:null};validationUntil=now()+5000;}
      return validation;
    })();
    try {return await validating;} finally {validating=null;}
  }
  function limit(id) {
    for(const [key,value] of rates) if(value.until<=now()) rates.delete(key);
    if(!rates.has(id)) {if(rates.size>=10000) throw fail(429,'The market is busy.');rates.set(id,{count:0,until:now()+60000});}
    if(++rates.get(id).count>40) throw fail(429,'Too many market requests. Wait a minute.');
    // Retain pending results for a day; expired issued orders remain briefly to explain expiry.
    for(const [key,value] of orders) if(value.submitted?value.createdAt+86400000<=now():value.expiresAt+60000<=now()) orders.delete(key);
  }
  const binding=(order,message=order.message)=>hash(JSON.stringify([order.account,order.session,order.wallet,order.inputMint,order.outputMint,order.amount,order.expiresAt,hash(message)]));
  const pending=order=>({status:'Pending',orderId:order.id,signature:order.signature,explorerUrl:`https://solscan.io/tx/${order.signature}`,message:'Confirmation is pending. Check this transaction before starting another swap.'});
  async function status(order) {
    if(order.result) return order.result;
    if(!order.inFlight) {
      try {
        const result=(await rpc('getSignatureStatuses',[[order.signature],{searchTransactionHistory:true}])).value?.[0];
        if(result && Object.hasOwn(result,'err') && (result.err===null || typeof result.err==='object') && ['confirmed','finalized'].includes(result.confirmationStatus)) order.result={status:result.err?'Failed':'Success',signature:order.signature,orderId:order.id,explorerUrl:`https://solscan.io/tx/${order.signature}`,...(result.err?{message:'The transaction failed on chain.'}:{})};
      } catch { /* A read failure cannot establish whether submission landed. */ }
    }
    return order.result || pending(order);
  }
  return async(req,res)=>{
    let path;try {path=new URL(req.url,'http://realm').pathname;} catch {return false;}
    if(path!=='/api/market' && !path.startsWith('/api/market/')) return false;
    try {
      let user;try {user=await identity(req);} catch {throw fail(503,'Realm identity is temporarily unavailable.');}
      if(!user || !['string','number'].includes(typeof user.id) || !String(user.id)) throw fail(401,'Sign into your realm account first.');
      if(req.headers['sec-fetch-site']==='cross-site' || (req.headers.origin!==undefined && req.headers.origin!==config.origin)) throw fail(403,'Origin rejected.');
      if((path==='/api/market/config' && req.method!=='GET') || (['/api/market/order','/api/market/execute'].includes(path) && req.method!=='POST')) throw fail(405,'Method not allowed.');
      if(!['/api/market/config','/api/market/order','/api/market/execute'].includes(path)) throw fail(404,'Unknown market endpoint.');
      if(req.method==='POST' && (req.headers.origin!==config.origin || req.headers['x-realm-market']!=='1' || !/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type']||''))) throw fail(403,'A same-origin JSON market request is required.');
      const account=String(user.id);limit(account);
      let wallet;try {wallet=await resolveWallet(user.id);} catch {throw fail(503,'Verified wallet binding is temporarily unavailable.');}
      wallet=address(wallet)?wallet:null;
      if(path==='/api/market/config') {
        const state=await validated();return send(res,200,{...state,tokenMint:config.mint,tokenSymbol:config.symbol,cluster:'mainnet-beta',wallet,settlementEnabled:false});
      }
      const input=await body(req);
      if(path==='/api/market/order') {
        onlyKeys(input,['direction','amount']);
        if(!['sol-to-token','token-to-sol'].includes(input.direction) || !atoms(input.amount)) throw fail(400,'Choose SOL or the launch token and enter a positive whole base-unit amount within u64.');
      } else onlyKeys(input,['orderId','signedTransaction']);
      const session=hash(`${account}\0${user.sessionId ?? req.headers.cookie ?? ''}`);
      if(path==='/api/market/execute') {
        const order=typeof input.orderId==='string'?orders.get(input.orderId):null;
        if(!order || order.account!==account || order.session!==session) throw fail(404,'Market order was not found for this session.');
        if(wallet!==order.wallet) throw fail(409,'Your linked wallet changed. Request a new quote.');
        if(order.submitted) {const result=await status(order);return send(res,result.status==='Pending'?202:200,result);}
        if(input.signedTransaction===undefined) return send(res,200,{status:'NotSubmitted',orderId:order.id,message:'This order was not submitted. Request and review a fresh quote.'});
        if(order.expiresAt<=now()) throw fail(410,'The quote expired. Request a new quote.');
        const state=await validated();if(!state.enabled) throw fail(503,state.reason);
        const tx=transaction(input.signedTransaction),message=Buffer.from(tx.message.serialize());
        if(binding(order,message)!==order.digest || tx.message.staticAccountKeys[0]?.toBase58()!==wallet) throw fail(400,'The signed transaction differs from the reviewed quote.');
        const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(wallet).toBuffer()]),format:'der',type:'spki'});
        if(!verify(null,message,publicKey,tx.signatures[0])) throw fail(400,'A valid signature from your linked wallet is required.');
        if(order.lastValidBlockHeight!==null) {
          let height;try {height=await rpc('getBlockHeight',[{commitment:'confirmed'}]);} catch {throw fail(503,'Cannot verify quote validity. No transaction was submitted.');}
          if(!Number.isSafeInteger(height) || height<0) throw fail(503,'Cannot verify quote validity.');
          if(height>order.lastValidBlockHeight) throw fail(410,'The transaction blockhash expired. Request a new quote.');
        }
        try {await validateRoute({tx,wallet,inputMint:order.inputMint,outputMint:order.outputMint,amount:order.amount,quotedOutAmount:order.quotedOutAmount,maxSlippageBps:config.maxSlippageBps,rpc});} catch {throw fail(503,'The reviewed route could not be safely revalidated. No transaction was submitted.');}
        // Reserve synchronously after every validation await, before sending any bytes upstream.
        if(order.submitted) return send(res,202,pending(order));
        if(order.expiresAt<=now()) throw fail(410,'The quote expired. Request a new quote.');
        order.submitted=true;order.inFlight=true;order.signature=base58(tx.signatures[0]);
        try {
          await upstream(`${JUPITER}/execute`,{method:'POST',headers,body:JSON.stringify({requestId:order.requestId,signedTransaction:input.signedTransaction,...(order.lastValidBlockHeight===null?{}:{lastValidBlockHeight:order.lastValidBlockHeight})})});
          // Errors, including upstream timeouts labelled Failed, require chain reconciliation.
        } catch { /* An ambiguous transport result must never be retried as a new execution. */ }
        finally {order.inFlight=false;}
        const result=await status(order);return send(res,result.status==='Pending'?202:200,result);
      }
      const state=await validated();if(!state.enabled) throw fail(503,state.reason);
      if(!wallet) throw fail(409,'Link and verify a wallet before requesting a quote.');
      const active=[...orders.values()].filter(order=>!order.result && (order.submitted || order.expiresAt>now()));
      if(orders.size>=10000 || active.length>=1000 || active.filter(order=>order.account===account).length>=10) throw fail(429,'Too many open market orders. Wait for existing quotes to expire.');
      const inputMint=input.direction==='sol-to-token'?SOL_MINT:config.mint,outputMint=input.direction==='sol-to-token'?config.mint:SOL_MINT;
      const params=new URLSearchParams({inputMint,outputMint,amount:input.amount,taker:wallet,maxSupportedTransactionVersion:'0'});
      let result,tx,safety;try {
        result=await upstream(`${JUPITER}/order?${params}`,{headers});
        if(typeof result.requestId!=='string' || !result.requestId || result.requestId.length>200 || !atoms(result.outAmount) || result.inputMint!==inputMint || result.outputMint!==outputMint || result.inAmount!==input.amount) throw new Error();
        tx=transaction(result.transaction);
        if(tx.message.staticAccountKeys[0]?.toBase58()!==wallet) throw new Error();
        if(result.router!=='metis') throw new Error();
        safety=await validateRoute({tx,wallet,inputMint,outputMint,amount:input.amount,quotedOutAmount:result.outAmount,maxSlippageBps:config.maxSlippageBps,rpc});
      } catch {throw fail(502,'No supported, verified executable quote is available. Liquidity, wallet funds or the route format may be unavailable.');}
      let expiresAt=now()+60000;
      if(result.expireAt!==undefined && result.expireAt!==null) {
        const raw=result.expireAt;
        const upstreamExpiry=typeof raw==='number'?raw*1000:typeof raw==='string' && /^\d{10}$/.test(raw)?Number(raw)*1000:typeof raw==='string' && /^\d{13}$/.test(raw)?Number(raw):Date.parse(raw);
        if(!Number.isFinite(upstreamExpiry) || upstreamExpiry<=now()) throw fail(502,'The upstream quote has expired.');
        expiresAt=Math.min(expiresAt,upstreamExpiry);
      }
      const rawHeight=result.lastValidBlockHeight;
      const lastValidBlockHeight=rawHeight===undefined || rawHeight===null?null:typeof rawHeight==='string' && /^\d{1,16}$/.test(rawHeight)?Number(rawHeight):rawHeight;
      if(lastValidBlockHeight!==null && (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight<0)) throw fail(502,'Invalid transaction expiry.');
      const order={id:randomUUID(),requestId:result.requestId,account,session,wallet,inputMint,outputMint,amount:input.amount,quotedOutAmount:result.outAmount,minimumOut:safety.minimumOut,createdAt:now(),expiresAt,lastValidBlockHeight,message:Buffer.from(tx.message.serialize()),submitted:false};
      order.digest=binding(order);orders.set(order.id,order);
      return send(res,200,{orderId:order.id,inputMint,outputMint,inAmount:input.amount,outAmount:result.outAmount,minimumOut:safety.minimumOut,networkFeeLamports:safety.networkFeeLamports,transaction:result.transaction,expiresAt,tokenDecimals:state.tokenDecimals,tokenSymbol:config.symbol,router:'metis',feeBps:0,feeMint:null,priceImpactPct:typeof result.priceImpactPct==='string'?result.priceImpactPct.slice(0,32):null,messageHash:hash(order.message)});
    } catch(error) {return send(res,error.status || 500,{error:error.status?error.message:'The market could not complete this request.'});}
  };
}
