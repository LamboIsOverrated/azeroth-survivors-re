import {createAccounting} from '../kernel.mjs';
import {configuration} from '../amounts.mjs';
import {input,dependencies} from './fixtures.mjs';
import {eventWorld,character,quote} from './event-fixtures.mjs';
const [path,id,mode]=process.argv.slice(2),config=configuration(input),deps=dependencies(config);eventWorld(deps.world,config);
deps.world.characters.set('10',{...deps.world.character(1,'10'),moneyUnits:'30',version:'1'});
deps.world.characters.set('20',{...deps.world.character(2,'20'),moneyUnits:'20',version:'1'});
const kernel=createAccounting({path,config,...deps});process.send('ready');
process.once('message',async()=>{
 try{
  const eventId=mode==='same'?'shared':id;
  await kernel.prepareEvent(quote({id:eventId,family:'trade',participants:[{accountId:1,guid:'10'},{accountId:2,guid:'20'}],legs:[{id:'offer',from:character(1,'10'),to:character(2,'20'),units:'25'}]}));
  if(mode==='crash'){process.send({ok:true},()=>process.exit(0));return;}
  process.send({ok:true});
 }catch(error){process.send({ok:false,error:error.message});}
 kernel.close();process.disconnect();
});
