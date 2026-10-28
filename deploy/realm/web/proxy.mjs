import {createServer,request as httpRequest} from 'node:http';
import {pipeline} from 'node:stream';
import {isIP} from 'node:net';

const clientAddress=(req,env)=>{
  // Only the configured Railway public ingress overwrites X-Real-IP. Private services
  // in this dedicated environment are trusted; never enable this on a direct listener.
  const edge=req.headers['x-real-ip'];
  const address=env.TRUST_RAILWAY_EDGE==='1'&&typeof edge==='string'&&isIP(edge)?edge:req.socket.remoteAddress;
  return isIP(address||'')?address:null;
};
const headersFor=(req,env)=>{
  const headers={...req.headers};
  for(const key of Object.keys(headers)) if(key==='forwarded'||key.startsWith('x-forwarded-')||key==='x-real-ip'||key==='proxy-authorization')delete headers[key];
  const address=clientAddress(req,env);
  if(isIP(address||''))headers['x-forwarded-for']=address;
  return headers;
};
const json=(res,code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'private, no-store'});res.end(JSON.stringify(value));};
const targetFor=(raw,base)=>{
  if(typeof raw!=='string'||!raw.startsWith('/')||raw.startsWith('//')||raw.includes('\\'))throw new Error('Invalid request path.');
  const path=new URL(raw,'http://local');const target=new URL(base);target.pathname=path.pathname;target.search=path.search;return target;
};
export function createWebGateway({realmUrl='http://127.0.0.1:8090',publicOrigin,economyFactory,dbPath,env={},fetchImpl=fetch,status=()=>({state:'starting',message:'The realm is starting.'}),walletAsset,walletStyle}={}) {
  const configuredOrigin=new URL(publicOrigin).origin;
  if(publicOrigin!==configuredOrigin)throw new Error('A single public origin without a path is required.');
  const publicResponses=new WeakMap(),requestCookies=new WeakMap();
  const realmRequest=async(req,path)=>{
    const headers={cookie:requestCookies.get(req)||req.headers.cookie||''};const address=clientAddress(req,env);if(address)headers['x-forwarded-for']=address;
    const response=await fetchImpl(new URL(path,realmUrl),{headers,signal:AbortSignal.timeout(5000)});
    const cookies=response.headers.getSetCookie?.()||[];
    if(cookies.length) {
      const res=publicResponses.get(req);const previous=res?.getHeader('set-cookie')||[];
      if(res&&!res.headersSent)res.setHeader('set-cookie',[...(Array.isArray(previous)?previous:[previous]),...cookies]);
      const jar=new Map((requestCookies.get(req)||req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.includes('=')).map(x=>{const split=x.indexOf('=');return [x.slice(0,split),x.slice(split+1)];}));
      for(const cookie of cookies){const pair=cookie.split(';',1)[0],split=pair.indexOf('=');if(split>0)jar.set(pair.slice(0,split),pair.slice(split+1));}
      requestCookies.set(req,[...jar].map(([key,value])=>`${key}=${value}`).join('; '));
    }
    return response;
  };
  const identity=async req=>{
    const response=await realmRequest(req,'/api/identity');
    if(!response.ok){await response.body?.cancel();return null;}
    const who=await response.json();
    if(!Number.isSafeInteger(who?.id)||who.id<=0||typeof who.username!=='string'||typeof who.isAdmin!=='boolean')return null;
    return {id:who.id,username:who.username,isAdmin:who.isAdmin};
  };
  const getCharacters=async req=>{const response=await realmRequest(req,'/api/character-balances');if(!response.ok){await response.body?.cancel();throw new Error('Character balances unavailable.');}return response.json();};
  const economy=economyFactory?.({identity,getCharacters,dbPath,env,fetchImpl});
  const gateway=createServer(async(req,res)=>{
    publicResponses.set(req,res);
    res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');
    let target;
    try {target=targetFor(req.url,realmUrl);}catch{return json(res,400,{error:'Invalid request path.'});}
    if(target.pathname==='/healthz'&&req.method==='GET')return json(res,200,{status:'ok',realm:status(),mainnetTransfers:false});
    if(target.pathname==='/readyz'&&req.method==='GET') {
      const realm=status();return json(res,realm.state==='ready'?200:503,{realm,mainnetTransfers:false});
    }
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin!==configuredOrigin)return json(res,403,{error:'This request must come from the game page.'});
    if(req.method==='GET'&&((target.pathname==='/realm-wallet.bundle.js'&&walletAsset)||(target.pathname==='/realm-wallet.bundle.css'&&walletStyle))) {
      const css=target.pathname.endsWith('.css');res.writeHead(200,{'content-type':css?'text/css':'text/javascript','cache-control':'private, no-cache'});return res.end(css?walletStyle:walletAsset);
    }
    if(target.pathname==='/api/economy'||target.pathname.startsWith('/api/economy/')) {
      res.setHeader('cache-control','private, no-store');
      try {if(economy&&await economy(req,res))return;}catch{if(!res.headersSent)return json(res,503,{error:'The account wallet is temporarily unavailable.'});return res.destroy();}
      return json(res,503,{error:'The account wallet is starting.'});
    }
    const forwarded=httpRequest(target,{method:req.method,headers:headersFor(req,env)},upstream=>{
      const headers={...upstream.headers};delete headers['transfer-encoding'];delete headers.connection;
      // Game data is private, while immutable reads must stay warm for synchronous WASM XHR.
      headers['cache-control']=target.pathname.startsWith('/data/')&&upstream.statusCode===200?'private, max-age=31536000, immutable':(headers['cache-control']||'private, no-store');
      res.writeHead(upstream.statusCode,headers);pipeline(upstream,res,()=>{});
    });
    forwarded.on('error',()=>{if(!res.headersSent)json(res,503,{error:status().message||'The realm is starting. Please retry shortly.'});else res.destroy();});
    forwarded.setTimeout(30000,()=>forwarded.destroy());req.on('aborted',()=>forwarded.destroy());pipeline(req,forwarded,()=>{});
  });
  gateway.on('upgrade',(req,socket,head)=>{
    let target;
    try{target=targetFor(req.url,realmUrl);}catch{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;}
    if(req.headers.origin!==configuredOrigin||!['/ws/3724','/ws/8085'].includes(target.pathname)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
    }
    const forwarded=httpRequest(target,{headers:headersFor(req,env)});
    forwarded.on('upgrade',(response,upstream,upstreamHead)=>{
      upstream.setTimeout(0);
      const lines=['HTTP/1.1 101 Switching Protocols'];
      for(let i=0;i<response.rawHeaders.length;i+=2)lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}`);
      socket.write(lines.join('\r\n')+'\r\n\r\n');
      if(upstreamHead.length)socket.write(upstreamHead);if(head.length)upstream.write(head);
      socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
      socket.on('close',()=>upstream.destroy());upstream.on('close',()=>socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    forwarded.on('response',response=>{socket.end(`HTTP/1.1 ${response.statusCode} Refused\r\nConnection: close\r\n\r\n`);response.resume();});
    forwarded.on('error',()=>socket.destroy());forwarded.setTimeout(10000,()=>forwarded.destroy());forwarded.end();
  });
  gateway.on('close',()=>economy?.close?.());
  return gateway;
}
