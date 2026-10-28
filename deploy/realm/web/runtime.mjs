import {spawn} from 'node:child_process';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWebGateway} from './proxy.mjs';
import {createEconomy} from '../economy/api.mjs';
import {createMarket} from '../market/index.mjs';
import {realmState,clientDataComplete} from './state.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const stateRoot=process.env.REALM_STATE_DIR||'/state';
const realmUrl='http://127.0.0.1:8090';
const publicOrigin=process.env.REALM_PUBLIC_URL;
if(!publicOrigin)throw new Error('REALM_PUBLIC_URL is required.');
await mkdir(stateRoot,{recursive:true});
const maintenance=process.env.REALM_MAINTENANCE==='1';
let state=maintenance?{state:'maintenance',message:'The realm is temporarily closed for maintenance.'}:{state:'starting',message:'The realm is starting.'};
let child,stopped=false,polling=false;
const walletAsset=await readFile(resolve(here,'../economy/public/realm-wallet.bundle.js'));
const walletStyle=await readFile(resolve(here,'../economy/public/realm-wallet.bundle.css'));
const marketAsset=await readFile(resolve(here,'../market/public/realm-market.bundle.js'));
const marketStyle=await readFile(resolve(here,'../market/public/realm-market.bundle.css'));
const server=createWebGateway({realmUrl,publicOrigin,status:()=>state,walletAsset,walletStyle,marketAsset,marketStyle,gatePlayUntilReady:true,dbPath:resolve(stateRoot,'economy.sqlite'),env:{...process.env,PUBLIC_ORIGIN:publicOrigin},economyFactory:maintenance?undefined:createEconomy,marketFactory:maintenance?undefined:createMarket});
server.listen(Number(process.env.PORT||8080),'0.0.0.0',()=>console.log(`Public realm gateway listening on ${server.address().port}.`));

function preparationFailed() {
  state={state:'error',message:'The world could not finish preparing. Please try again later.'};
  server.close();setTimeout(()=>process.exit(1),250).unref();
}
function python(script,args=[],extraEnv={}) {
  return new Promise(resolveExit=>{
    child=spawn('python3',[script,...args],{env:{...process.env,...extraEnv},stdio:'inherit'});
    child.on('error',()=>resolveExit(-1));child.on('exit',resolveExit);
  });
}
async function startRealm() {
  if(stopped)return;
  const data=process.env.CLIENT_DATA||resolve(stateRoot,'client/DerivedData');
  const original=process.env.CLIENT_SOURCE_DATA||resolve(stateRoot,'client/Data');
  if(resolve(data)===resolve(original))throw new Error('Original and derived client data must use separate directories.');
  if(!await clientDataComplete(original)) {
    if(process.env.DOWNLOAD_GAME_DATA!=='true') {state={state:'waiting',message:'The realm is waiting for its game files.'};return;}
    state={state:'initializing',message:'Preparing the game files for first use. Character creation will open when the realm is ready.'};
    const exit=await python(resolve(here,'prepare_data.py'),[],{CLIENT_DATA:original});
    if(stopped)return;if(exit!==0)return preparationFailed();
  }
  // Size canaries cannot detect same-size corruption or a mismatched restored dataset.
  // The helper verifies every source hash and the derived content before every boot.
  state={state:'initializing',message:'Verifying the world files.'};
  const exit=await python(resolve(here,'../core/repair_client.py'),['--source',original,'--output',data]);
  if(stopped)return;if(exit!==0)return preparationFailed();
  if(!await clientDataComplete(data))return preparationFailed();
  state={state:'starting',message:'Starting the account and browser game service.'};
  child=spawn(process.env.REALM_BINARY||'/app/bin/wenilla-realm',[],{env:{...process.env,REALM_BIND:'127.0.0.1:8090',REALM_STATE_DIR:stateRoot,CLIENT_DATA:data},stdio:'inherit'});
  child.on('error',()=>{state={state:'error',message:'The account service could not start.'};server.close();setTimeout(()=>process.exit(1),250).unref();});
  child.on('exit',code=>{if(!stopped){console.error(`Account service exited (${code}).`);state={state:'error',message:'The account service is restarting.'};server.close();setTimeout(()=>process.exit(1),250).unref();}});
}
const statusTimer=setInterval(async()=>{
  if(stopped||maintenance||polling||['initializing','waiting','error'].includes(state.state))return;
  polling=true;
  try {
    const response=await fetch(`${realmUrl}/healthz`,{signal:AbortSignal.timeout(5000)});
    const health=await response.json();
    const core=await fetch(process.env.CORE_STATUS_URL||'http://realm-core.railway.internal:8080/healthz',{signal:AbortSignal.timeout(3000)});
    const body=await core.json();
    state=realmState(response.ok,health,core.ok?body:{});
  }catch{state={state:'world-unavailable',message:'The realm is starting or restarting. Saved characters remain on the server.'};}
  finally{polling=false;}
},5000);
if(!maintenance)startRealm().catch(error=>{console.error('Realm startup failed:',error.code||error.name);preparationFailed();});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{
  stopped=true;clearInterval(statusTimer);child?.kill('SIGTERM');server.close();
  setTimeout(()=>process.exit(0),10000).unref();
});
