import { Ledger } from '../ledger.mjs';
const ledger = new Ledger(process.argv[2]);
process.on('message', () => {
  try {
    ledger.post({accountId:1,operationId:process.argv[3],delta:-70n,kind:'test-spend'});
    process.send({spent:true});
  } catch { process.send({spent:false}); }
  finally { ledger.close(); process.disconnect(); }
});
process.send({ready:true});
