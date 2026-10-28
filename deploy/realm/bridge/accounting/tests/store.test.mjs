import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Ledger} from '../../../economy/ledger.mjs';
import {config as chain} from '../../../economy/settlement/tests/fixtures.mjs';
import {configuration,gameAtoms,atoms} from '../amounts.mjs';
import {AccountingStore} from '../store.mjs';

export const input={...chain,namespaceId:'closed-live-fixture',phase:'LIVE',atomsPerGameUnit:'100'};
test('conversion is immutable positive exact integer arithmetic with raw u64 and game caps',()=>{
 const cfg=configuration(input);assert.equal(gameAtoms('9007199',cfg),'900719900');
 assert.equal(atoms('18446744073709551615'),18446744073709551615n);
 for(const bad of ['0','-1','01','1.0','1e3',100])assert.throws(()=>configuration({...input,atomsPerGameUnit:bad}));
 for(const bad of ['2147483647','01',1])assert.throws(()=>gameAtoms(bad,cfg));
 assert.throws(()=>gameAtoms('2',configuration({...input,atomsPerGameUnit:'18446744073709551615'})));
 assert.throws(()=>configuration({...input,phase:'TEST'}));assert.throws(()=>configuration({}));
});
test('append-only double entry rejects unbalanced/negative claims and payload-changing duplicate batches',()=>{
 const store=new AccountingStore(':memory:',configuration(input));
 try{
  const post=()=>store.post({key:'deposit:fixture',kind:'deposit',payload:{accountId:1,atoms:'1000'},postings:[{bucket:'external_reserve',owner:'system',delta:-1000n},{bucket:'vault_available',owner:'account:1',delta:1000n}]});
  store.atomic(post);store.atomic(post);assert.equal(store.balance('vault_available','account:1'),'1000');assert.equal(store.totals().reserveAtoms,'1000');
  assert.throws(()=>store.atomic(()=>store.post({key:'bad',kind:'invalid',payload:{},postings:[{bucket:'vault_available',owner:'account:1',delta:1n}]})));
  assert.throws(()=>store.atomic(()=>store.post({key:'overdraw',kind:'invalid',payload:{},postings:[{bucket:'vault_available',owner:'account:2',delta:-1n},{bucket:'vault_available',owner:'account:1',delta:1n}]})));
  assert.throws(()=>store.atomic(()=>store.post({key:'deposit:fixture',kind:'deposit',payload:{accountId:2,atoms:'1000'},postings:[{bucket:'external_reserve',owner:'system',delta:-1000n},{bucket:'vault_available',owner:'account:2',delta:1000n}]})));
  assert.equal(store.balance('vault_available','account:1'),'1000');assert.equal(store.totals().claimsAtoms,'1000');
  assert.throws(()=>store.db.prepare("UPDATE ac_postings SET delta='0'").run(),/append.only/);
  assert.throws(()=>store.db.prepare('DELETE FROM ac_batches').run(),/append.only/);
 }finally{store.close();}
});
test('dedicated namespace survives reopen and refuses configuration reinterpretation or TEST database import',()=>{
 const dir=mkdtempSync(join(tmpdir(),'closed-accounting-')),path=join(dir,'live.sqlite');
 let store=new AccountingStore(path,configuration(input));store.close();
 store=new AccountingStore(path,configuration(input));store.close();
 assert.throws(()=>new AccountingStore(path,configuration({...input,atomsPerGameUnit:'101'})),/immutable/i);
 const broken=new DatabaseSync(path);broken.exec('DROP TABLE ac_events');broken.close();
 assert.throws(()=>new AccountingStore(path,configuration(input)),/incomplete|foreign/);
 const legacyPath=join(dir,'test.sqlite'),legacy=new Ledger(legacyPath);legacy.allocate(1,'100');legacy.close();
 assert.throws(()=>new AccountingStore(legacyPath,configuration(input)),/dedicated|foreign|TEST/);
 const reader=new DatabaseSync(legacyPath);assert.equal(reader.prepare('SELECT delta FROM journal').get().delta,100);assert.equal(reader.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'ac_%'").get().n,0);reader.close();
 rmSync(dir,{recursive:true,force:true});
});
