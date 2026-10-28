import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

function account(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4294967295)
    throw new Error("Trusted realm account required");
  return value;
}
function units(value, { zero = false, max = 2147483646n } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
    throw new Error("Exact integer units required");
  const result = BigInt(value);
  if ((!zero && result === 0n) || result > max)
    throw new Error("Units outside cap");
  return result;
}
function guid(value) {
  units(value, { max: 4294967295n });
  return value;
}
function command(row, action) {
  return `realmbridge v1 TEST ${action} ${row.id} ${row.direction} ${row.account_id} ${row.guid} ${row.units} ${row.expected_before}`;
}
const terminal = (row) => ["applied", "rejected"].includes(row.state);
function view(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    guid: row.guid,
    units: row.units,
    direction: row.direction,
    expectedBefore: row.expected_before,
    state: row.state,
    phase: "TEST",
  };
}

export class BridgeOutbox {
  constructor({
    dbPath,
    phase,
    transport,
    authorizeCharacter,
    now = Date.now,
  }) {
    if (phase !== "TEST")
      throw new Error(
        "LIVE world bridge is disabled until all game issuance is backed",
      );
    if (
      typeof transport?.execute !== "function" ||
      typeof authorizeCharacter !== "function" ||
      typeof dbPath !== "string"
    )
      throw new Error(
        "Trusted world transport, ownership resolver and TEST ledger path required",
      );
    this.transport = transport;
    this.authorizeCharacter = authorizeCharacter;
    this.now = now;
    this.db = new DatabaseSync(dbPath);
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
    SELECT sequence,account_id,delta,kind FROM journal LIMIT 0;
    CREATE TABLE IF NOT EXISTS world_bridge_outbox(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,request_key TEXT NOT NULL,guid TEXT NOT NULL,units TEXT NOT NULL,direction TEXT NOT NULL CHECK(direction IN ('grant','debit')),expected_before TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('queued','pending','applied','rejected')),receipt TEXT,created_at INTEGER NOT NULL,UNIQUE(account_id,request_key)) STRICT;
    CREATE TRIGGER IF NOT EXISTS bridge_intent_immutable BEFORE UPDATE ON world_bridge_outbox WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.request_key IS NOT OLD.request_key OR NEW.guid IS NOT OLD.guid OR NEW.units IS NOT OLD.units OR NEW.direction IS NOT OLD.direction OR NEW.expected_before IS NOT OLD.expected_before OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'immutable bridge intent');END;
  `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  balance(id) {
    const statement = this.db.prepare(
      "SELECT delta FROM journal WHERE account_id=? ORDER BY sequence",
    );
    statement.setReadBigInts(true);
    return statement.all(account(id)).reduce((sum, row) => sum + row.delta, 0n);
  }
  post(id, operation, delta, kind) {
    const next = this.balance(id) + delta;
    if (next < 0n || next > 9223372036854775807n)
      throw new Error("Insufficient TEST vault units");
    this.db
      .prepare(
        "INSERT INTO journal(operation_id,account_id,delta,kind,created_at) VALUES(?,?,?,?,?)",
      )
      .run(operation, id, delta, kind, this.now());
  }
  row(id, owner) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid bridge operation");
    const row = this.db
      .prepare("SELECT * FROM world_bridge_outbox WHERE id=? AND account_id=?")
      .get(id, account(owner));
    if (!row) throw new Error("Bridge operation not found for account");
    return row;
  }
  get({ accountId, id }) {
    return view(this.row(id, accountId));
  }
  pending() {
    return this.db
      .prepare(
        "SELECT * FROM world_bridge_outbox WHERE state IN ('queued','pending') ORDER BY created_at LIMIT 100",
      )
      .all()
      .map(view);
  }
  async enqueue({
    accountId: id,
    idempotencyKey,
    guid: characterGuid,
    units: amount,
    direction,
  }) {
    account(id);
    guid(characterGuid);
    const quantity = units(amount);
    if (
      !["grant", "debit"].includes(direction) ||
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(idempotencyKey)
    )
      throw new Error("Invalid typed bridge request");
    const character = await this.authorizeCharacter(id, characterGuid);
    if (
      character?.accountId !== id ||
      character.guid !== characterGuid ||
      character.online !== false ||
      character.loading !== false
    )
      throw new Error("Character must be owned, offline and not loading");
    units(character.moneyUnits, { zero: true });
    return this.transaction(() => {
      const prior = this.db
        .prepare(
          "SELECT * FROM world_bridge_outbox WHERE account_id=? AND request_key=?",
        )
        .get(id, idempotencyKey);
      if (prior) {
        if (
          prior.guid !== characterGuid ||
          prior.units !== amount ||
          prior.direction !== direction
        )
          throw new Error("Bridge idempotency conflict");
        return view(prior);
      }
      const nonce = randomBytes(32).toString("hex");
      if (direction === "grant")
        this.post(
          id,
          `world-reserve:${nonce}`,
          -quantity,
          "test-bridge-reserve",
        );
      this.db
        .prepare(
          "INSERT INTO world_bridge_outbox(id,account_id,request_key,guid,units,direction,expected_before,state,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)",
        )
        .run(
          nonce,
          id,
          idempotencyKey,
          characterGuid,
          amount,
          direction,
          character.moneyUnits,
          this.now(),
        );
      return view(this.row(nonce, id));
    });
  }
  verify(row, receipt) {
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.phase !== "TEST" ||
      receipt.id !== row.id ||
      receipt.direction !== row.direction ||
      receipt.accountId !== String(row.account_id) ||
      receipt.guid !== row.guid ||
      receipt.units !== row.units ||
      receipt.expectedBefore !== row.expected_before ||
      !["applied", "rejected"].includes(receipt.state)
    )
      throw new Error("World receipt does not match durable request");
    const before = units(receipt.before, { zero: true }),
      after = units(receipt.after, { zero: true });
    if (
      receipt.state === "applied" &&
      (before !== BigInt(row.expected_before) ||
        after - before !==
          (row.direction === "grant" ? 1n : -1n) * BigInt(row.units) ||
        receipt.reason !== "")
    )
      throw new Error("World receipt amount mismatch");
    if (
      receipt.state === "rejected" &&
      (before !== after ||
        !["owner", "stale", "balance", "cap", "online"].includes(
          receipt.reason,
        ))
    )
      throw new Error("Invalid durable world rejection");
  }
  async step({ accountId: id, id: operationId }) {
    const row = this.row(operationId, id);
    if (terminal(row)) return view(row);
    this.transaction(() => {
      const current = this.row(operationId, id);
      if (!terminal(current))
        this.db
          .prepare("UPDATE world_bridge_outbox SET state='pending' WHERE id=?")
          .run(operationId);
    });
    try {
      let receipt = await this.transport.execute(command(row, "status"));
      if (receipt?.state === "absent" && receipt.id === row.id)
        receipt = await this.transport.execute(command(row, "apply"));
      this.verify(row, receipt);
      return this.transaction(() => {
        const current = this.row(operationId, id);
        if (terminal(current)) return view(current);
        if (receipt.state === "rejected" && row.direction === "grant")
          this.post(
            id,
            `world-release:${row.id}`,
            BigInt(row.units),
            "test-bridge-release",
          );
        if (receipt.state === "applied" && row.direction === "debit")
          this.post(
            id,
            `world-credit:${row.id}`,
            BigInt(row.units),
            "test-bridge-credit",
          );
        this.db
          .prepare(
            "UPDATE world_bridge_outbox SET state=?,receipt=? WHERE id=?",
          )
          .run(receipt.state, JSON.stringify(receipt), row.id);
        return view(this.row(row.id, id));
      });
    } catch {
      return this.get({ accountId: id, id: operationId });
    }
  }
  close() {
    this.db.close();
  }
}
