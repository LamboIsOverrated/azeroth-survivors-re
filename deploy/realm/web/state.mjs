import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';

export function realmState(httpOk,health={},core={}) {
  if(!httpOk||health.sqlite!==true)return {state:'account-unavailable',message:'The account service is restarting.'};
  if(health.client_data!==true)return {state:'data-unavailable',message:'The game files need initialization or repair.'};
  if(health.mariadb!==true)return {state:'database-unavailable',message:'The character database is temporarily unavailable.'};
  if(health.soap!==true||core.ready!==true)return {state:'world-initializing',message:'Accounts are available. The world server is preparing or restarting.'};
  return {state:'ready',message:'The PvP realm is ready.'};
}
export async function clientDataComplete(data) {
  try {
    const manifest=JSON.parse(await readFile(join(data,'.client-data.json'),'utf8'));
    if(!Array.isArray(manifest.files)||manifest.files.length<2||manifest.files.length>100)return false;
    const names=new Set();
    for(const file of manifest.files) {
      if(!/^[A-Za-z0-9 _-]+\.mpq$/i.test(file.name)||!Number.isSafeInteger(file.size)||file.size<=0||names.has(file.name.toLowerCase()))return false;
      names.add(file.name.toLowerCase());const info=await stat(join(data,file.name));
      if(!info.isFile()||info.size!==file.size)return false;
    }
    return names.has('terrain.mpq')&&names.has('patch.mpq');
  }catch{return false;}
}
