import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {realmState,clientDataComplete} from '../state.mjs';

test('readiness requires real account, database, SOAP and complete data health, not HTTP200 alone',()=>{
  const healthy={sqlite:true,mariadb:true,soap:true,client_data:true};
  assert.equal(realmState(true,healthy,{ready:true}).state,'ready');
  for(const key of Object.keys(healthy))assert.notEqual(realmState(true,{...healthy,[key]:false},{ready:true}).state,'ready');
  assert.notEqual(realmState(false,healthy,{ready:true}).state,'ready');
  assert.notEqual(realmState(true,healthy,{ready:false}).state,'ready');
  assert.notEqual(realmState(true,{},{}).state,'ready');
});
test('two canaries cannot bypass interrupted full data extraction and manifests validate all file sizes',async t=>{
  const data=await mkdtemp(join(tmpdir(),'realm-input-'));t.after(()=>rm(data,{recursive:true,force:true}));
  await writeFile(join(data,'terrain.MPQ'),'aaa');await writeFile(join(data,'patch.MPQ'),'bbb');
  assert.equal(await clientDataComplete(data),false);
  const manifest={files:[{name:'terrain.MPQ',size:3},{name:'patch.MPQ',size:3},{name:'model.MPQ',size:3}]};
  await writeFile(join(data,'.client-data.json'),JSON.stringify(manifest));
  assert.equal(await clientDataComplete(data),false);
  await writeFile(join(data,'model.MPQ'),'ccc');assert.equal(await clientDataComplete(data),true);
  await writeFile(join(data,'model.MPQ'),'x');assert.equal(await clientDataComplete(data),false);
});
