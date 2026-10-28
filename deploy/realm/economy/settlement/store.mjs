import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_U64 } from "./protocol.mjs";

export function accountId(id) {
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("Authenticated account ID required");
  return id;
}
export class SettlementStore {
  constructor(path, config) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS live_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS live_journal(sequence INTEGER PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,account_id INTEGER NOT NULL,available_delta TEXT NOT NULL,reserved_delta TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS live_journal_account ON live_journal(account_id,sequence);
        CREATE TABLE IF NOT EXISTS live_deposit_intents(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,wallet TEXT NOT NULL,source_token_account TEXT NOT NULL,atoms TEXT NOT NULL,memo TEXT NOT NULL UNIQUE,created_slot INTEGER NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,signature TEXT UNIQUE) STRICT;
        CREATE TABLE IF NOT EXISTS live_withdrawals(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,request_key TEXT NOT NULL,wallet TEXT NOT NULL,destination_token_account TEXT NOT NULL,atoms TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('reserved','signed','pending','settled','failed','expired')),created_at INTEGER NOT NULL,signed_transaction TEXT,signature TEXT UNIQUE,blockhash TEXT,last_valid_block_height INTEGER,blockhash_slot INTEGER,UNIQUE(account_id,request_key)) STRICT;
        CREATE TABLE IF NOT EXISTS live_events(sequence INTEGER PRIMARY KEY,withdrawal_id TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
        CREATE TRIGGER IF NOT EXISTS live_journal_no_update BEFORE UPDATE ON live_journal BEGIN SELECT RAISE(ABORT,'append-only LIVE journal'); END;
        CREATE TRIGGER IF NOT EXISTS live_journal_no_delete BEFORE DELETE ON live_journal BEGIN SELECT RAISE(ABORT,'append-only LIVE journal'); END;
        CREATE TRIGGER IF NOT EXISTS live_events_no_update BEFORE UPDATE ON live_events BEGIN SELECT RAISE(ABORT,'append-only LIVE events'); END;
        CREATE TRIGGER IF NOT EXISTS live_events_no_delete BEFORE DELETE ON live_events BEGIN SELECT RAISE(ABORT,'append-only LIVE events'); END;
        CREATE TRIGGER IF NOT EXISTS live_config_no_update BEFORE UPDATE ON live_config BEGIN SELECT RAISE(ABORT,'immutable LIVE configuration'); END;
        CREATE TRIGGER IF NOT EXISTS live_config_no_delete BEFORE DELETE ON live_config BEGIN SELECT RAISE(ABORT,'immutable LIVE configuration'); END;
        CREATE TRIGGER IF NOT EXISTS live_withdrawals_immutable BEFORE UPDATE ON live_withdrawals WHEN
          NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.request_key IS NOT OLD.request_key OR NEW.wallet IS NOT OLD.wallet OR NEW.destination_token_account IS NOT OLD.destination_token_account OR NEW.atoms IS NOT OLD.atoms OR NEW.created_at IS NOT OLD.created_at OR
          (OLD.signed_transaction IS NOT NULL AND (NEW.signed_transaction IS NOT OLD.signed_transaction OR NEW.signature IS NOT OLD.signature OR NEW.blockhash IS NOT OLD.blockhash OR NEW.last_valid_block_height IS NOT OLD.last_valid_block_height OR NEW.blockhash_slot IS NOT OLD.blockhash_slot))
          BEGIN SELECT RAISE(ABORT,'immutable withdrawal intent/transaction'); END;
      `);
      this.transaction(() => {
        const value = JSON.stringify(config),
          prior = this.db
            .prepare("SELECT value FROM live_config WHERE singleton=1")
            .get();
        if (prior && prior.value !== value)
          throw new Error(
            "Settlement configuration cannot change for an existing ledger",
          );
        if (!prior)
          this.db
            .prepare("INSERT INTO live_config(singleton,value) VALUES(1,?)")
            .run(value);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  balance(id) {
    accountId(id);
    let available = 0n,
      reserved = 0n;
    for (const row of this.db
      .prepare(
        "SELECT available_delta,reserved_delta FROM live_journal WHERE account_id=? ORDER BY sequence",
      )
      .all(id)) {
      available += BigInt(row.available_delta);
      reserved += BigInt(row.reserved_delta);
    }
    if (available < 0n || reserved < 0n || available + reserved > MAX_U64)
      throw new Error("LIVE ledger invariant violated");
    return {
      namespace: "LIVE_ATOMS",
      available: available.toString(),
      reserved: reserved.toString(),
    };
  }
  liabilities() {
    let total = 0n;
    for (const row of this.db
      .prepare(
        "SELECT available_delta,reserved_delta FROM live_journal ORDER BY sequence",
      )
      .all())
      total += BigInt(row.available_delta) + BigInt(row.reserved_delta);
    if (total < 0n || total > MAX_U64)
      throw new Error("LIVE liabilities outside mint limit");
    return total;
  }
  append({
    operationId,
    accountId: id,
    available = 0n,
    reserved = 0n,
    kind,
    now,
  }) {
    const before = this.balance(id);
    if (
      BigInt(before.available) + available < 0n ||
      BigInt(before.reserved) + reserved < 0n ||
      BigInt(before.available) +
        available +
        BigInt(before.reserved) +
        reserved >
        MAX_U64
    )
      throw new Error("Insufficient LIVE balance");
    this.db
      .prepare(
        "INSERT INTO live_journal(operation_id,account_id,available_delta,reserved_delta,kind,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(operationId, id, String(available), String(reserved), kind, now);
  }
  event(id, state, now) {
    this.db
      .prepare(
        "INSERT INTO live_events(withdrawal_id,state,created_at) VALUES(?,?,?)",
      )
      .run(id, state, now);
  }
  withdrawal(id, owner) {
    const row = this.db
      .prepare("SELECT * FROM live_withdrawals WHERE id=? AND account_id=?")
      .get(id, accountId(owner));
    if (!row) throw new Error("Withdrawal not found for account");
    return row;
  }
  history(id) {
    return this.db
      .prepare(
        "SELECT operation_id,available_delta,reserved_delta,kind,created_at FROM live_journal WHERE account_id=? ORDER BY sequence DESC LIMIT 100",
      )
      .all(accountId(id))
      .map((row) => ({
        operationId: row.operation_id,
        availableDelta: row.available_delta,
        reservedDelta: row.reserved_delta,
        kind: row.kind,
        createdAt: row.created_at,
      }));
  }
  close() {
    this.db.close();
  }
}
