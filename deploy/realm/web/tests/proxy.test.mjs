import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {once} from 'node:events';
import {createWebGateway} from '../proxy.mjs';

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server,'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function fixture(t, options={}) {
  const seen=[];
  const realm=createServer((req,res)=>{
    seen.push({url:req.url,host:req.headers.host,forwarded:req.headers['x-forwarded-for']});
    if(options.realmHandler?.(req,res))return;
    if(req.url==='/api/identity') {
      res.setHeader('content-type','application/json');
      if(req.headers.cookie!=='realm=valid') {res.writeHead(401);return res.end('{}');}
      return res.end(JSON.stringify({id:17,username:'tester',isAdmin:false}));
    }
    res.end('realm');
  });
  const realmUrl=await listen(realm);
  const gateway=createWebGateway({realmUrl,publicOrigin:'https://realm.example',...options});
  const url=await listen(gateway);
  t.after(()=>{gateway.closeAllConnections();gateway.close();realm.closeAllConnections();realm.close();});
  return {url,seen,gateway,realm};
}
test('normal requests reach only the configured loopback realm and preserve the public Host',async t=>{
  const {url,seen}=await fixture(t);
  const body=await new Promise((resolve,reject)=>{const req=request(`${url}/play`,{headers:{host:'realm.example','x-forwarded-for':'attacker'}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve(data));});req.on('error',reject);req.end();});
  assert.equal(body,'realm');
  assert.equal(seen.at(-1).host,'realm.example');
  assert.equal(seen.at(-1).forwarded,'127.0.0.1');
});
test('hidden identity and character requests forward a rotated session cookie back to the browser',async t=>{
  const {url}=await fixture(t,{
    realmHandler:(req,res)=>{
      if(req.url==='/api/identity') {
        assert.equal(req.headers.cookie,'realm=old');res.setHeader('set-cookie',['realm=new; Path=/; HttpOnly; Secure','other=unchanged; Path=/']);
        res.setHeader('content-type','application/json');res.end(JSON.stringify({id:17,username:'tester',isAdmin:false}));return true;
      }
      if(req.url==='/api/character-balances') {
        assert.match(req.headers.cookie,/realm=new/);res.setHeader('content-type','application/json');res.end('{"characters":[]}');return true;
      }
      return false;
    },
    economyFactory:({identity,getCharacters})=>async(req,res)=>{
      if(!req.url.startsWith('/api/economy/'))return false;
      await identity(req);await getCharacters(req);res.end('ok');return true;
    },
  });
  const response=await fetch(`${url}/api/economy/state`,{headers:{cookie:'realm=old'}});
  assert.equal(response.status,200);assert.match(response.headers.getSetCookie().join('\n'),/realm=new; Path=/);
  assert.match(response.headers.getSetCookie().join('\n'),/other=unchanged/);
});
test('only explicit Railway edge mode accepts a validated edge client IP and never user XFF',async t=>{
  const {url,seen}=await fixture(t,{env:{TRUST_RAILWAY_EDGE:'1'}});
  await fetch(`${url}/login`,{headers:{'x-real-ip':'203.0.113.8','x-forwarded-for':'attacker, 192.0.2.9'}});
  assert.equal(seen.at(-1).forwarded,'203.0.113.8');
  await fetch(`${url}/login`,{headers:{'x-real-ip':'attacker, 203.0.113.8','x-forwarded-for':'192.0.2.9'}});
  assert.notEqual(seen.at(-1).forwarded,'192.0.2.9');assert.notEqual(seen.at(-1).forwarded,'attacker, 203.0.113.8');
});
test('absolute and protocol-relative request targets cannot escape the configured realm',async t=>{
  const {url,seen}=await fixture(t);
  for(const path of ['//attacker.invalid/','http://attacker.invalid/','/\\attacker.invalid/']) {
    const status=await new Promise((resolve,reject)=>{const req=request(url,{path},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
    assert.equal(status,400);
  }
  assert.equal(seen.length,0);
});
test('economy identity is derived from the actual realm session and never request account fields',async t=>{
  const {url}=await fixture(t,{economyFactory:({identity})=>async(req,res)=>{
    if(!req.url.startsWith('/api/economy/'))return false;
    const who=await identity(req);res.setHeader('content-type','application/json');res.writeHead(who?200:401);res.end(JSON.stringify(who));return true;
  }});
  assert.equal((await fetch(`${url}/api/economy/me?id=999`)).status,401);
  const response=await fetch(`${url}/api/economy/me?id=999`,{headers:{cookie:'realm=valid'}});
  assert.deepEqual(await response.json(),{id:17,username:'tester',isAdmin:false});
  assert.equal(response.headers.get('cache-control'),'private, no-store');
});
test('mutation origin must exactly match the configured origin',async t=>{
  const {url,seen}=await fixture(t);
  for(const origin of ['https://attacker.invalid','http://realm.example','https://realm.example.attacker.invalid']) {
    assert.equal((await fetch(`${url}/login`,{method:'POST',headers:{origin}})).status,403);
  }
  assert.equal((await fetch(`${url}/login`,{method:'POST'})).status,403);
  assert.equal(seen.length,0);
  assert.equal((await fetch(`${url}/login`,{method:'POST',headers:{origin:'https://realm.example'}})).status,200);
});
test('readiness names the web runtime independently of realm readiness',async t=>{
  const {url}=await fixture(t,{status:()=>({state:'initializing',message:'Preparing game data.'})});
  const response=await fetch(`${url}/healthz`);assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{status:'ok',realm:{state:'initializing',message:'Preparing game data.'},ready:false,maintenance:false,mainnetTransfers:false});
  assert.equal((await fetch(`${url}/readyz`)).status,503);
});
test('websocket forwarding requires the exact origin and fixed ports, and preserves upstream authentication refusal',async t=>{
  const {url,realm}=await fixture(t);
  let upgrades=0;
  realm.on('upgrade',(req,socket)=>{
    upgrades++;
    if(req.headers.cookie!=='realm=valid')return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const upgrade=(path,origin,cookie)=>new Promise((resolve,reject)=>{
    const headers={connection:'Upgrade',upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'dGhlIHNhbXBsZSBub25jZQ=='};
    if(origin)headers.origin=origin;if(cookie)headers.cookie=cookie;
    const req=request(`${url}${path}`,{headers});
    req.on('upgrade',(response,socket)=>{resolve(response.statusCode);socket.destroy();});
    req.on('response',response=>{response.resume();resolve(response.statusCode);});
    req.on('error',reject);req.setTimeout(3000,()=>req.destroy(new Error('Upgrade timed out')));req.end();
  });
  assert.equal(await upgrade('/ws/3306','https://realm.example','realm=valid'),403);
  assert.equal(await upgrade('/ws/8085','https://attacker.invalid','realm=valid'),403);
  assert.equal(await upgrade('/ws/8085',null,'realm=valid'),403);
  assert.equal(upgrades,0);
  assert.equal(await upgrade('/ws/3724','https://realm.example'),401);
  assert.equal(await upgrade('/ws/8085','https://realm.example','realm=valid'),101);
  assert.equal(upgrades,2);
});
test('wallet JavaScript and CSS use their correct types without forwarding them to the realm',async t=>{
  const {url,seen}=await fixture(t,{walletAsset:Buffer.from('export {};'),walletStyle:Buffer.from('dialog {}')});
  for(const [path,type] of [['js','text/javascript'],['css','text/css']]) {
    const response=await fetch(`${url}/realm-wallet.bundle.${path}`);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),type);
  }
  assert.equal(seen.length,0);
});
test('unready play pages show an honest waiting screen and never boot a partial world',async t=>{
  const {url,seen}=await fixture(t,{gatePlayUntilReady:true,status:()=>({state:'world-initializing',message:'Preparing <world> files.'})});
  const response=await fetch(`${url}/play`);assert.equal(response.status,503);assert.match(response.headers.get('content-type'),/text\/html/);
  const html=await response.text();assert.match(html,/Preparing &lt;world&gt; files\./);assert.doesNotMatch(html,/<canvas/);assert.equal(seen.length,0);
});
