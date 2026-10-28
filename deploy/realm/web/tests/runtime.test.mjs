import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

async function environment(t) {
  const root=await mkdtemp(join(tmpdir(),'realm-runtime-'));
  t.after(async()=>{assert.equal(resolve(root).startsWith(resolve(tmpdir())+'/realm-runtime-')||resolve(root).startsWith(resolve(tmpdir())+'\\realm-runtime-'),true);await rm(root,{recursive:true,force:true});});
  return {...process.env,PORT:'0',REALM_PUBLIC_URL:'https://realm.example',REALM_STATE_DIR:root,CLIENT_DATA:join(root,'Data'),DOWNLOAD_GAME_DATA:'false',REALM_BINARY:join(root,'missing-server'),ROOT:root};
}
function start(env) {
  return spawn(process.execPath,[fileURLToPath(new URL('../runtime.mjs',import.meta.url))],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
}
test('maintenance wrapper stays available while account and economy databases remain unopened',async t=>{
  const env=await environment(t);env.REALM_MAINTENANCE='1';const child=start(env);let stderr='';child.stderr.on('data',data=>stderr+=data);
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'close');}});
  const port=await new Promise((resolvePort,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`Gateway did not start: ${stderr}`)),10000);
    child.stdout.on('data',data=>{const match=String(data).match(/listening on (\d+)/);if(match){clearTimeout(timer);resolvePort(match[1]);}});
    child.on('exit',code=>{clearTimeout(timer);reject(new Error(`Gateway exited ${code}: ${stderr}`));});
  });
  const response=await fetch(`http://127.0.0.1:${port}/healthz`);const health=await response.json();
  assert.equal(health.maintenance,true);assert.equal(health.ready,false);
  assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status,503);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/economy/state`)).status,503);
  assert.deepEqual(await readdir(env.ROOT),[]);
});
test('missing realm executable terminates the wrapper for platform restart instead of staying falsely healthy',async t=>{
  const env=await environment(t);env.REALM_MAINTENANCE='0';await mkdir(env.CLIENT_DATA);
  for(const name of ['terrain.MPQ','patch.MPQ'])await writeFile(join(env.CLIENT_DATA,name),'abc');
  await writeFile(join(env.CLIENT_DATA,'.client-data.json'),JSON.stringify({files:[{name:'terrain.MPQ',size:3},{name:'patch.MPQ',size:3}]}));
  const child=start(env);child.stdout.resume();let stderr='';child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill(),10000);const [code]=await once(child,'close');clearTimeout(timer);
  assert.equal(code,1,stderr);
});
