import { Buffer } from 'buffer';
import { VersionedTransaction } from '@solana/web3.js';
globalThis.Buffer ??= Buffer;

export function parseUnits(value,decimals) {
  if(!Number.isInteger(decimals) || decimals<0 || decimals>255 || typeof value!=='string' || value.length>280 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) throw new Error('Enter a positive decimal amount.');
  const [whole,fraction='']=value.split('.');
  if(fraction.length>decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const raw=BigInt(whole+fraction.padEnd(decimals,'0'));
  if(raw<=0n || raw>18446744073709551615n) throw new Error('Amount is outside the supported range.');return raw.toString();
}
export function formatUnits(value,decimals) {
  if(typeof value!=='string' || !/^\d{1,20}$/.test(value) || !Number.isInteger(decimals) || decimals<0 || decimals>255) throw new Error('Invalid token amount.');
  const digits=BigInt(value).toString().padStart(decimals+1,'0');if(!decimals) return digits;
  const fraction=digits.slice(-decimals).replace(/0+$/,'');return digits.slice(0,-decimals)+(fraction?`.${fraction}`:'');
}
export function chooseProvider(wallet,scope=globalThis) {
  const providers=[scope.phantom?.solana,scope.solana?.isPhantom?scope.solana:null,scope.solflare];
  const provider=providers.find(item=>item?.publicKey?.toBase58?.()===wallet && typeof item.signTransaction==='function');
  if(!provider) throw new Error('Open Phantom or Solflare with your linked wallet selected, then refresh the market.');return provider;
}
function signatureOf(bytes) {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let value=BigInt(`0x${Buffer.from(bytes).toString('hex')}`),result='';
  while(value) {result=alphabet[Number(value%58n)]+result;value/=58n;}
  for(const byte of bytes) {if(byte) break;result='1'+result;}return result;
}
export function createMarketSession({fetchImpl=globalThis.fetch,scope=globalThis,now=Date.now,onChange=()=>{}}={}) {
  const state={config:null,phase:'loading',quote:null,result:null,busy:false};
  async function api(path,body) {
    const response=await fetchImpl(`/api/market${path}`,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json','x-realm-market':'1'},body:JSON.stringify(body)})});
    let result;try {result=await response.json();} catch {throw new Error('The market response could not be read.');}
    if(!response.ok) throw new Error(result.error || 'The market request did not complete.');return result;
  }
  const changed=()=>onChange(state);
  const storageKey=()=>state.config?.wallet?`realm-market-pending:${state.config.wallet}`:null;
  function remember() {try {const key=storageKey();if(key) {if(state.phase==='pending') scope.sessionStorage?.setItem(key,JSON.stringify({orderId:state.result.orderId,signature:state.result.signature}));else scope.sessionStorage?.removeItem(key);}} catch { /* Storage may be blocked by browser privacy settings. */ }}
  async function run(action) {
    if(state.busy) throw new Error('A market request is already in progress.');state.busy=true;changed();
    try {return await action();} finally {state.busy=false;changed();}
  }
  const controller={state,
    refresh:()=>run(async()=>{
      state.config=await api('/config');
      if(state.phase!=='pending') {
        let saved;try {saved=JSON.parse(scope.sessionStorage?.getItem(storageKey()) || 'null');} catch {}
        if(saved && typeof saved.orderId==='string' && typeof saved.signature==='string') {state.phase='pending';state.result={status:'Pending',...saved};}
        else {state.phase='idle';state.quote=null;}
      }
      return state.config;
    }),
    requestQuote:(direction,value)=>run(async()=>{
      if(state.phase==='pending') throw new Error('A previous transaction is pending. Check its status before starting another swap.');
      const config=state.config;if(!config?.enabled) throw new Error(config?.reason || 'The market is closed.');
      if(!config.wallet) throw new Error('Link and verify your Phantom or Solflare wallet first.');
      if(!['sol-to-token','token-to-sol'].includes(direction)) throw new Error('Choose a swap direction.');
      state.quote=null;state.result=null;state.phase='idle';
      const quote=await api('/order',{direction,amount:parseUnits(value,direction==='sol-to-token'?9:config.tokenDecimals)});
      if(!quote.transaction || typeof quote.orderId!=='string' || quote.expiresAt<=now()) throw new Error('No valid executable quote was returned.');
      state.quote={...quote,wallet:config.wallet,direction};state.phase='review';return state.quote;
    }),
    cancel:()=>{if(!state.busy && state.phase==='review') {state.quote=null;state.phase='idle';changed();}},
    signAndExecute:()=>run(async()=>{
      const quote=state.quote;if(state.phase!=='review' || !quote) throw new Error('Request and review a quote first.');
      if(quote.expiresAt<=now()) {state.phase='idle';state.quote=null;throw new Error('This quote expired. Request a new quote.');}
      if(state.config.wallet!==quote.wallet) throw new Error('Your linked wallet changed. Request a new quote.');
      const provider=chooseProvider(quote.wallet,scope),tx=VersionedTransaction.deserialize(Buffer.from(quote.transaction,'base64'));
      const message=Buffer.from(tx.message.serialize());
      const signed=await provider.signTransaction(tx);
      if(provider.publicKey?.toBase58?.()!==quote.wallet || !Buffer.from(signed.message.serialize()).equals(message)) throw new Error('The wallet transaction differs from the reviewed quote.');
      if(quote.expiresAt<=now()) {state.phase='idle';state.quote=null;throw new Error('The quote expired while signing. Request a new quote.');}
      const signature=signatureOf(signed.signatures[0]);
      if(!signed.signatures[0].some(value=>value!==0)) throw new Error('The wallet did not sign this transaction.');
      state.phase='pending';state.result={status:'Pending',orderId:quote.orderId,signature};remember();changed();
      // Once bytes might reach the server, only explicit read-only checks may follow.
      try {
        const result=await api('/execute',{orderId:quote.orderId,signedTransaction:Buffer.from(signed.serialize()).toString('base64')});
        state.result={...result,orderId:quote.orderId,signature:result.signature || signature};state.phase=result.status==='Pending'?'pending':'complete';remember();return state.result;
      } catch {return state.result;}
    }),
    check:()=>run(async()=>{
      if(state.phase!=='pending' || !state.result?.orderId) throw new Error('No pending transaction to check.');
      const result=await api('/execute',{orderId:state.result.orderId});
      if(result.status==='NotSubmitted') {state.phase='idle';state.quote=null;state.result=result;}
      else {state.result={...state.result,...result};state.phase=result.status==='Pending'?'pending':'complete';}
      remember();return state.result;
    }),
  };return controller;
}
