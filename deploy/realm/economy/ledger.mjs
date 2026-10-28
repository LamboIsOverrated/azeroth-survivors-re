import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_UNITS = 9223372036854775807n;
export const MAX_TEST_ALLOCATION = 1000000000n;

export function parseUnits(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error('Expected integer units as a decimal string');
  const units = BigInt(value);
  if (units > MAX_UNITS) throw new Error('Amount exceeds ledger limit');
  return units;
}

// Conversion helper only: no conversion between TEST and any launch token exists.
export function parseDecimalAtoms(value, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18 || typeof value !== 'string' || value.length > 100) throw new Error('Invalid decimal amount');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error('Amount must be exact without rounding');
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0') || '0');
}

export function accountId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid account identity');
  return value;
}

export class Ledger {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS journal (
        sequence INTEGER PRIMARY KEY,
        operation_id TEXT NOT NULL UNIQUE,
        account_id INTEGER NOT NULL CHECK(account_id > 0),
        delta INTEGER NOT NULL CHECK(delta != 0),
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS journal_account ON journal(account_id, sequence);
      CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'append-only journal'); END;
      CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'append-only journal'); END;
      CREATE TABLE IF NOT EXISTS wallet_challenges (
        account_id INTEGER PRIMARY KEY,
        nonce TEXT NOT NULL UNIQUE,
        wallet TEXT NOT NULL,
        origin TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS wallet_bindings (
        account_id INTEGER PRIMARY KEY,
        wallet TEXT NOT NULL UNIQUE,
        linked_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  balance(id) {
    accountId(id);
    const statement = this.db.prepare('SELECT COALESCE(SUM(delta),0) AS units FROM journal WHERE account_id=?');
    statement.setReadBigInts(true);
    return statement.get(id).units.toString();
  }

  // Server-only primitive. No public route accepts delta, reward, spend or operation IDs.
  post({accountId: id, operationId, delta, kind}) {
    accountId(id);
    if (typeof operationId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(operationId) || !['test-credit', 'test-spend', 'test-allocation'].includes(kind)) throw new Error('Invalid journal operation');
    if (typeof delta !== 'bigint' || delta === 0n || delta > MAX_UNITS || delta < -MAX_UNITS) throw new Error('Invalid journal amount');
    return this.transaction(() => {
      const statement = this.db.prepare('SELECT account_id, delta, kind FROM journal WHERE operation_id=?');
      statement.setReadBigInts(true);
      const prior = statement.get(operationId);
      if (prior) {
        if (prior.account_id !== BigInt(id) || prior.delta !== delta || prior.kind !== kind) throw new Error('Operation ID conflict');
        return this.balance(id);
      }
      const next = BigInt(this.balance(id)) + delta;
      if (next < 0n || next > MAX_UNITS) throw new Error('Insufficient balance or ledger limit');
      this.db.prepare('INSERT INTO journal(operation_id,account_id,delta,kind,created_at) VALUES(?,?,?,?,?)').run(operationId,id,delta,kind,Date.now());
      return next.toString();
    });
  }

  allocate(id, units) {
    accountId(id);
    const amount = parseUnits(units);
    if (amount < 1n || amount > MAX_TEST_ALLOCATION) throw new Error('Test allocation out of range');
    // One immutable allocation per account, even if configuration changes later.
    const operationId = `test-allocation:${id}`;
    const prior = this.db.prepare('SELECT delta FROM journal WHERE operation_id=?');
    prior.setReadBigInts(true);
    const existing = prior.get(operationId);
    return this.post({accountId: id, operationId, delta: existing?.delta ?? amount, kind: 'test-allocation'});
  }

  history(id) {
    accountId(id);
    const statement = this.db.prepare('SELECT sequence,delta,kind,created_at FROM journal WHERE account_id=? ORDER BY sequence DESC LIMIT 50');
    statement.setReadBigInts(true);
    return statement.all(id).map(row => ({sequence: row.sequence.toString(), units: row.delta.toString(), kind: row.kind, createdAt: Number(row.created_at)}));
  }

  wallet(id) { return this.db.prepare('SELECT wallet FROM wallet_bindings WHERE account_id=?').get(accountId(id))?.wallet ?? null; }
  close() { this.db.close(); }
}
