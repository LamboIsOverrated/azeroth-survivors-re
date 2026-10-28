import {DatabaseSync} from 'node:sqlite';
import {canonical,hash,U64,configuration,identifier} from './amounts.mjs';

const originalTables=['ac_namespace','ac_batches','ac_postings','ac_intents','ac_deposits','ac_characters','ac_operations','ac_locks','ac_receipts','ac_events'];
const tables=[...originalTables,'ac_schema','ac_escrows','ac_retired'];
const buckets=new Set(['external_reserve','vault_available','vault_reserved','withdrawal_reserved','world_allocated','world_escrow','pool_available','pool_reserved','escrow_available','event_reserved']);
function ownerFor(bucket,owner){
 const pattern=bucket==='external_reserve'?/^system$/:bucket==='vault_available'?/^account:[1-9][0-9]*$/:bucket==='world_allocated'?/^character:[1-9][0-9]*$/:bucket==='pool_available'?/^pool:[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/:bucket==='escrow_available'?/^escrow:[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/:/^operation:[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;
 if(!buckets.has(bucket)||!pattern.test(owner))throw Error('Invalid posting bucket/owner');
}
// Internal primitive. Public callers receive the kernel facade, never this database or post().
export class AccountingStore{
 constructor(path,input){
  this.config=configuration(input);this.db=new DatabaseSync(path);this.inTransaction=false;
  try{
   this.db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
   const existing=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(x=>x.name);
   const legacy=existing.length===originalTables.length&&originalTables.every(x=>existing.includes(x));
   if(existing.some(x=>!tables.includes(x))||(existing.length&&!legacy&&existing.length!==tables.length))throw Error('Dedicated empty database required; incomplete/foreign/TEST ledger refused');
   if(legacy){
    if(this.db.prepare("SELECT COUNT(*) n FROM ac_operations WHERE state!='complete'").get().n)throw Error('Drain schema 1 pending operations before atomic-event upgrade');
    this.db.exec(`ALTER TABLE ac_locks RENAME TO ac_locks_v1;
     CREATE TABLE ac_locks(guid TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES ac_operations(id));
     INSERT INTO ac_locks SELECT * FROM ac_locks_v1; DROP TABLE ac_locks_v1;`);
   }
   this.db.exec(`
    CREATE TABLE IF NOT EXISTS ac_namespace(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_batches(key TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_postings(batch_key TEXT NOT NULL REFERENCES ac_batches(key),ordinal INTEGER NOT NULL,bucket TEXT NOT NULL,owner TEXT NOT NULL,delta TEXT NOT NULL,PRIMARY KEY(batch_key,ordinal));
    CREATE INDEX IF NOT EXISTS ac_postings_owner ON ac_postings(bucket,owner);
    CREATE TABLE IF NOT EXISTS ac_intents(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_deposits(signature TEXT PRIMARY KEY,intent_id TEXT UNIQUE NOT NULL REFERENCES ac_intents(id),account_id INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_characters(guid TEXT PRIMARY KEY,account_id INTEGER NOT NULL,units TEXT NOT NULL,version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_operations(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);
    CREATE TABLE IF NOT EXISTS ac_locks(guid TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES ac_operations(id));
    CREATE TABLE IF NOT EXISTS ac_receipts(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE NOT NULL REFERENCES ac_operations(id),payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_events(id TEXT PRIMARY KEY,operation_id TEXT UNIQUE NOT NULL REFERENCES ac_operations(id));
    CREATE TABLE IF NOT EXISTS ac_schema(version INTEGER PRIMARY KEY,contract TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_escrows(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ac_retired(guid TEXT PRIMARY KEY,account_id INTEGER NOT NULL,operation_id TEXT NOT NULL REFERENCES ac_operations(id));
   `);
   const row=this.db.prepare('SELECT version,config FROM ac_namespace').get(),text=canonical(this.config);
   if(row&&(row.version!==1||row.config!==text))throw Error('Immutable LIVE namespace/configuration mismatch');
   if(!row)this.db.prepare('INSERT INTO ac_namespace VALUES(1,1,?)').run(text);
   const schema=this.db.prepare('SELECT version,contract FROM ac_schema').all();
   if(schema.length&&!(schema.length===1&&schema[0].version===2&&schema[0].contract==='atomic-events-v1'))throw Error('Unsupported accounting schema');
   if(!schema.length)this.db.prepare('INSERT INTO ac_schema VALUES(2,?)').run('atomic-events-v1');
   for(const table of ['ac_namespace','ac_schema','ac_retired','ac_batches','ac_postings','ac_intents','ac_deposits','ac_receipts','ac_events'])for(const action of ['UPDATE','DELETE'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'append-only journal'); END`);
   this.db.exec('COMMIT');this.assertConserved();
  }catch(error){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw error;}
 }
 atomic(fn){
  if(this.inTransaction)throw Error('Nested accounting transaction');
  this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;
  try{const result=fn();if(result&&typeof result.then==='function')throw Error('Async transaction refused');this.assertConserved();this.db.exec('COMMIT');return result;}
  catch(error){this.db.exec('ROLLBACK');throw error;}finally{this.inTransaction=false;}
 }
 post({key,kind,payload,postings}){
  if(!this.inTransaction)throw Error('Atomic posting required');
  if(typeof key!=='string'||! /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}$/.test(key))throw Error('Invalid batch key');
  identifier(kind);
  const marker=postings?.length===0&&['event-reserve','event-applied','event-rejected'].includes(kind);
  if(!Array.isArray(postings)||(!marker&&postings.length<2)||postings.length>128)throw Error('Balanced postings required');
  let sum=0n;
  const rows=postings.map(({bucket,owner,delta})=>{ownerFor(bucket,owner);if(typeof delta!=='bigint'||delta===0n||delta>U64||delta< -U64)throw Error('Exact nonzero delta required');sum+=delta;return {bucket,owner,delta:delta.toString()};});
  if(sum!==0n)throw Error('Unbalanced batch');
  const fingerprint=hash({kind,payload,postings:rows}),old=this.db.prepare('SELECT fingerprint FROM ac_batches WHERE key=?').get(key);
  if(old){if(old.fingerprint!==fingerprint)throw Error('Idempotency payload conflict');return key;}
  this.db.prepare('INSERT INTO ac_batches VALUES(?,?,?,?)').run(key,kind,canonical(payload),fingerprint);
  const add=this.db.prepare('INSERT INTO ac_postings VALUES(?,?,?,?,?)');rows.forEach((row,i)=>add.run(key,i,row.bucket,row.owner,row.delta));
  this.assertConserved();return key;
 }
 balance(bucket,owner){ownerFor(bucket,owner);return this.db.prepare('SELECT delta FROM ac_postings WHERE bucket=? AND owner=?').all(bucket,owner).reduce((n,x)=>n+BigInt(x.delta),0n).toString();}
 totals(){
  const sums=new Map();for(const r of this.db.prepare('SELECT bucket,owner,delta FROM ac_postings').all()){ownerFor(r.bucket,r.owner);const key=r.bucket+'|'+r.owner;sums.set(key,(sums.get(key)??0n)+BigInt(r.delta));}
  let reserve=0n,claims=0n;for(const [key,n]of sums){const bucket=key.split('|')[0];if(bucket==='external_reserve'){if(n>0n)throw Error('Negative reserve');reserve-=n;}else{if(n<0n||n>U64)throw Error('Negative/overflowing claim');if(['world_allocated','world_escrow','escrow_available','event_reserved'].includes(bucket)&&n%BigInt(this.config.atomsPerGameUnit)!==0n)throw Error('Fractional world claim');claims+=n;}}
  return {reserveAtoms:reserve.toString(),claimsAtoms:claims.toString()};
 }
 assertConserved(){const t=this.totals();if(t.reserveAtoms!==t.claimsAtoms||BigInt(t.claimsAtoms)>U64)throw Error('Reserve conservation failed');}
 close(){this.db.close();}
}
