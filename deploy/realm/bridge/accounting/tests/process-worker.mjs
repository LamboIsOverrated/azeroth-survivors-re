import {createAccounting} from '../kernel.mjs';
import {input} from './fixtures.mjs';
const [path,id,mode]=process.argv.slice(2),kernel=createAccounting({path,config:input});
process.send('ready');
process.once('message',async()=>{
 try{
  if(mode==='same-operation')kernel.fundPool({id:'shared-fund',accountId:1,poolId:'rewards',atoms:'7000'});
  else kernel.fundPool({id,accountId:1,poolId:id,atoms:'7000'});
  process.send({ok:true});
 }catch(error){process.send({ok:false,error:error.message});}
 finally{kernel.close();process.disconnect();}
});
