import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { Ledger, parseUnits, parseDecimalAtoms } from '../ledger.mjs';

test('decimal parsing never rounds or accepts ambiguous numeric input', () => {
  assert.equal(parseDecimalAtoms('9007199254740993.000000001', 9), 9007199254740993000000001n);
  assert.equal(parseDecimalAtoms('0.01', 2), 1n);
  for (const value of ['1e3', '-1', '+1', ' 1', '01', '.1', '1.', '1.001', 1]) {
    assert.throws(() => parseDecimalAtoms(value, 2));
  }
  assert.equal(parseUnits('9007199254740993'), 9007199254740993n);
  for (const value of ['01', '1.1', '-1', '9223372036854775808', 12]) assert.throws(() => parseUnits(value));
});

test('append-only exact ledger isolates accounts and duplicate operation IDs', () => {
  const ledger = new Ledger(':memory:');
  try {
    ledger.post({accountId: 1, operationId: 'credit', delta: 9007199254740993n, kind: 'test-credit'});
    ledger.post({accountId: 1, operationId: 'credit', delta: 9007199254740993n, kind: 'test-credit'});
    assert.equal(ledger.balance(1), '9007199254740993');
    assert.equal(ledger.balance(2), '0');
    assert.throws(() => ledger.post({accountId: 2, operationId: 'credit', delta: 1n, kind: 'test-credit'}));
    assert.throws(() => ledger.post({accountId: 1, operationId: 'credit', delta: 2n, kind: 'test-credit'}));
    assert.throws(() => ledger.db.prepare('UPDATE journal SET delta=0').run(), /append.only/i);
    assert.throws(() => ledger.db.prepare('DELETE FROM journal').run(), /append.only/i);
  } finally { ledger.close(); }
});

test('transactional competing spends cannot overdraw and survive restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'realm-ledger-'));
  const path = join(dir, 'ledger.sqlite');
  let first = new Ledger(path);
  const second = new Ledger(path);
  try {
    first.allocate(1, '100');
    const results = await Promise.allSettled([
      Promise.resolve().then(() => first.post({accountId: 1, operationId: 'spend-a', delta: -70n, kind: 'test-spend'})),
      Promise.resolve().then(() => second.post({accountId: 1, operationId: 'spend-b', delta: -70n, kind: 'test-spend'})),
    ]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    first.close(); first = new Ledger(path);
    first.allocate(1, '999');
    assert.equal(first.balance(1), '30');
    assert.equal(first.history(1).length, 2);
    for (const bad of ['0', '-1', '1000000001']) assert.throws(() => first.allocate(2, bad));
  } finally { first.close(); second.close(); rmSync(dir, {recursive: true, force: true}); }
});

test('different processes cannot spend the same available funds', {timeout:15000}, async () => {
  const dir=mkdtempSync(join(tmpdir(),'realm-process-ledger-'));
  const path=join(dir,'economy.sqlite');
  const ledger=new Ledger(path);
  ledger.allocate(1,'100');
  const workers=[];
  try {
    const ready=[], results=[];
    for(const id of ['process-spend-a','process-spend-b']) {
      const worker=fork(new URL('./ledger-worker.mjs',import.meta.url),[path,id],{silent:true}); workers.push(worker);
      ready.push(new Promise((resolve,reject)=>{worker.on('error',reject);worker.once('message',message=>message.ready ? resolve() : reject(new Error('worker not ready')));}));
      results.push(new Promise((resolve,reject)=>{worker.on('message',message=>{if('spent' in message)resolve(message.spent);});worker.on('error',reject);}));
    }
    await Promise.all(ready);
    for(const worker of workers) worker.send({spend:true});
    assert.equal((await Promise.all(results)).filter(Boolean).length,1);
    assert.equal(ledger.balance(1),'30');
    assert.equal(ledger.history(1).length,2);
  } finally { for(const worker of workers) worker.kill(); ledger.close(); rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
});
