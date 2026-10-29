import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountingStore} from '../store.mjs';
import {configuration} from '../amounts.mjs';
import {input} from './fixtures.mjs';
for(const pending of [false,true])test('schema 1 '+(pending?'pending fails closed':'drained upgrades atomically without changing conversion or claims'),()=>{
 const dir=mkdtempSync(join(tmpdir(),'schema-event-')),path=join(dir,'live.sqlite'),config=configuration(input);let store=new AccountingStore(path,config);
 store.atomic(()=>store.post({key:'fixture-deposit',kind:'deposit',payload:{},postings:[{bucket:'external_reserve',owner:'system',delta:-1000n},{bucket:'vault_available',owner:'account:1',delta:1000n}]}));store.close();
 const db=new DatabaseSync(path);db.exec(`DROP TABLE ac_schema;DROP TABLE ac_escrows;DROP TABLE ac_retired;ALTER TABLE ac_locks RENAME TO locks_new;CREATE TABLE ac_locks(guid TEXT PRIMARY KEY,operation_id TEXT UNIQUE NOT NULL REFERENCES ac_operations(id));DROP TABLE locks_new;`);
 if(pending)db.prepare('INSERT INTO ac_operations VALUES(?,?,?,?,NULL)').run('old',1,'{}','reserved');db.close();
 try{
  if(pending){assert.throws(()=>new AccountingStore(path,config),/Drain/);const read=new DatabaseSync(path);assert.equal(read.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='ac_schema'").get().n,0);read.close();}
  else{store=new AccountingStore(path,config);assert.equal(store.config.hash,config.hash);assert.equal(store.totals().claimsAtoms,'1000');assert.equal(store.db.prepare('SELECT version FROM ac_schema').get().version,2);store.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
