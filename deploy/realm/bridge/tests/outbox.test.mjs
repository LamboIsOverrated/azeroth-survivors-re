import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Ledger } from "../../economy/ledger.mjs";
import { BridgeOutbox } from "../outbox.mjs";
import { DatabaseSync } from "node:sqlite";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "world-bridge-")),
    dbPath = join(dir, "test.sqlite");
  const ledger = new Ledger(dbPath);
  ledger.allocate(1, "100");
  const receipts = new Map();
  let fail = false,
    afterCommitTimeout = false,
    worldMoney = 50,
    applyCount = 0,
    realmAccountId = 42;
  const commands = [];
  const transport = {
    async execute(command) {
      commands.push(command);
      const [
        ,
        version,
        phase,
        action,
        id,
        direction,
        accountId,
        guid,
        units,
        expectedBefore,
      ] = command.split(" ");
      assert.equal(version, "v1");
      assert.equal(phase, "TEST");
      if (fail) throw new Error("unknown SOAP response");
      if (action === "status")
        return receipts.get(id) ?? { state: "absent", id };
      if (!receipts.has(id)) {
        applyCount++;
        const before = String(worldMoney);
        worldMoney += direction === "grant" ? Number(units) : -Number(units);
        receipts.set(id, {
          version: 1,
          phase,
          id,
          direction,
          accountId,
          guid,
          units,
          expectedBefore,
          state: "applied",
          before,
          after: String(worldMoney),
          reason: "",
        });
      }
      if (afterCommitTimeout) throw new Error("reply lost after COMMIT");
      return receipts.get(id);
    },
  };
  const options = {
    dbPath,
    phase: "TEST",
    transport,
    authorizeCharacter: async (id, guid) => ({
      accountId: id,
      realmAccountId,
      guid,
      moneyUnits: "50",
      online: false,
      loading: false,
    }),
  };
  let box = new BridgeOutbox(options);
  t.after(() => {
    box.close();
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ledger,
    transport,
    receipts,
    options,
    commands,
    set realmAccountId(value) {
      realmAccountId = value;
    },
    get box() {
      return box;
    },
    get worldMoney() {
      return worldMoney;
    },
    get applyCount() {
      return applyCount;
    },
    set fail(value) {
      fail = value;
    },
    set afterCommitTimeout(value) {
      afterCommitTimeout = value;
    },
    restart() {
      box.close();
      box = new BridgeOutbox(options);
    },
  };
}
const grant = (box) =>
  box.enqueue({
    accountId: 1,
    idempotencyKey: "grant-1",
    guid: "7",
    units: "70",
    direction: "grant",
  });
test("LIVE mode and ambiguous amounts fail before changing any TEST or live funds", async (t) => {
  const f = fixture(t);
  assert.throws(() => new BridgeOutbox({ ...f.options, phase: "LIVE" }));
  for (const units of ["0", "01", "1.1", "2147483647", 70])
    await assert.rejects(() =>
      f.box.enqueue({
        accountId: 1,
        idempotencyKey: "bad",
        guid: "7",
        units,
        direction: "grant",
      }),
    );
  assert.equal(f.ledger.balance(1), "100");
});
test("grant reserves actual TEST ledger funds atomically and idempotently before world delivery", async (t) => {
  const f = fixture(t);
  const row = await grant(f.box);
  assert.equal(f.ledger.balance(1), "30");
  assert.equal((await grant(f.box)).id, row.id);
  await assert.rejects(() =>
    f.box.enqueue({
      accountId: 1,
      idempotencyKey: "grant-2",
      guid: "7",
      units: "70",
      direction: "grant",
    }),
  );
  await assert.rejects(() =>
    f.box.enqueue({
      accountId: 1,
      idempotencyKey: "grant-1",
      guid: "7",
      units: "71",
      direction: "grant",
    }),
  );
  assert.equal(f.applyCount, 0);
  await f.box.step({ accountId: 1, id: row.id });
  assert.equal(f.worldMoney, 120);
  assert.equal(f.ledger.balance(1), "30");
  assert.equal(f.box.get({ accountId: 1, id: row.id }).state, "applied");
  assert.throws(() => f.box.get({ accountId: 2, id: row.id }));
});
test("lost commit reply and restart reconcile the receipt without creating a second world grant", async (t) => {
  const f = fixture(t),
    row = await grant(f.box);
  f.afterCommitTimeout = true;
  assert.equal(
    (await f.box.step({ accountId: 1, id: row.id })).state,
    "pending",
  );
  assert.equal(f.worldMoney, 120);
  f.restart();
  f.afterCommitTimeout = false;
  await Promise.all([
    f.box.step({ accountId: 1, id: row.id }),
    f.box.step({ accountId: 1, id: row.id }),
  ]);
  assert.equal(f.applyCount, 1);
  assert.equal(f.ledger.balance(1), "30");
  assert.equal(f.box.pending().length, 0);
});
test("unknown or mismatched receipt never releases reserved TEST funds", async (t) => {
  const f = fixture(t),
    row = await grant(f.box);
  f.fail = true;
  await f.box.step({ accountId: 1, id: row.id });
  assert.equal(f.ledger.balance(1), "30");
  f.fail = false;
  f.receipts.set(row.id, {
    ...row,
    version: 1,
    phase: "TEST",
    accountId: "2",
    state: "rejected",
    before: "50",
    after: "50",
    reason: "stale",
  });
  await f.box.step({ accountId: 1, id: row.id });
  assert.equal(f.ledger.balance(1), "30");
  assert.equal(f.box.get({ accountId: 1, id: row.id }).state, "pending");
});
test("durable rejection releases once and world debit credits vault only after matching receipt", async (t) => {
  const f = fixture(t),
    row = await grant(f.box);
  f.receipts.set(row.id, {
    version: 1,
    phase: "TEST",
    id: row.id,
    direction: "grant",
    accountId: "42",
    guid: "7",
    units: "70",
    expectedBefore: "50",
    state: "rejected",
    before: "50",
    after: "50",
    reason: "cap",
  });
  await f.box.step({ accountId: 1, id: row.id });
  f.restart();
  await f.box.step({ accountId: 1, id: row.id });
  assert.equal(f.ledger.balance(1), "100");
  const debit = await f.box.enqueue({
    accountId: 1,
    idempotencyKey: "debit-1",
    guid: "7",
    units: "20",
    direction: "debit",
  });
  assert.equal(f.ledger.balance(1), "100");
  await f.box.step({ accountId: 1, id: debit.id });
  assert.equal(f.ledger.balance(1), "120");
  assert.equal(f.worldMoney, 30);
  await f.box.step({ accountId: 1, id: debit.id });
  assert.equal(f.ledger.balance(1), "120");
});
test("trusted ownership and offline/loading state precede any reservation", async (t) => {
  const f = fixture(t);
  for (const changed of [
    { accountId: 2 },
    { guid: "8" },
    { online: true },
    { loading: true },
    { moneyUnits: 50 },
  ]) {
    const box = new BridgeOutbox({
      ...f.options,
      authorizeCharacter: async () => ({
        accountId: 1,
        realmAccountId: 42,
        guid: "7",
        moneyUnits: "50",
        online: false,
        loading: false,
        ...changed,
      }),
    });
    await assert.rejects(() => grant(box));
    box.close();
  }
  assert.equal(f.ledger.balance(1), "100");
});

test("deleted character durable rejection refunds a reserved grant exactly once after restart", async (t) => {
  const f = fixture(t),
    row = await grant(f.box);
  f.receipts.set(row.id, {
    version: 1,
    phase: "TEST",
    id: row.id,
    direction: "grant",
    accountId: "42",
    guid: "7",
    units: "70",
    expectedBefore: "50",
    state: "rejected",
    before: "0",
    after: "0",
    reason: "missing-character",
  });
  assert.equal(f.ledger.balance(1), "30");
  assert.equal(
    (await f.box.step({ accountId: 1, id: row.id })).state,
    "rejected",
  );
  f.restart();
  await Promise.all([
    f.box.step({ accountId: 1, id: row.id }),
    f.box.step({ accountId: 1, id: row.id }),
  ]);
  assert.equal(f.ledger.balance(1), "100");
  assert.equal(f.applyCount, 0);
  assert.equal(
    f.ledger.history(1).filter((entry) => entry.kind === "test-bridge-release")
      .length,
    1,
  );
});

test("unequal realm and web IDs route world changes without moving another journal owner's funds", async (t) => {
  const f = fixture(t);
  f.ledger.allocate(42, "200");
  const row = await grant(f.box);
  assert.equal(row.accountId, 1);
  assert.equal(row.realmAccountId, 42);
  await f.box.step({ accountId: 1, id: row.id });
  assert.equal(f.box.get({ accountId: 1, id: row.id }).state, "applied");
  assert.equal(f.ledger.balance(1), "30");
  assert.equal(f.ledger.balance(42), "200");
  assert.equal(f.worldMoney, 120);
  assert.ok(f.commands.every(command => command.split(" ")[6] === "42"));
  assert.throws(() => f.box.get({ accountId: 42, id: row.id }));
  await assert.rejects(f.box.step({ accountId: 42, id: row.id }));
});

test("a receipt echoing the web ID instead of the persisted realm ID stays pending", async (t) => {
  const f = fixture(t), row = await grant(f.box);
  f.receipts.set(row.id, {version:1, phase:"TEST", id:row.id, direction:"grant", accountId:"1", guid:"7", units:"70", expectedBefore:"50", state:"rejected", before:"50", after:"50", reason:"stale"});
  await f.box.step({ accountId:1, id:row.id });
  assert.equal(f.box.get({ accountId:1, id:row.id }).state,"pending");
  assert.equal(f.ledger.balance(1),"30");
  assert.equal(f.applyCount,0);
  f.receipts.set(row.id,{...f.receipts.get(row.id),accountId:"42"});
  await f.box.step({ accountId:1, id:row.id });
  assert.equal(f.ledger.balance(1),"100");
});

test("changed mappings cannot rebind an existing request and restart reconciles its original realm receipt", async (t) => {
  const f = fixture(t), row = await grant(f.box);
  f.afterCommitTimeout = true;
  await f.box.step({ accountId:1, id:row.id });
  assert.equal(f.worldMoney,120);
  f.realmAccountId=99;
  await assert.rejects(grant(f.box),/idempotency|mapping/i);
  f.restart();
  f.options.authorizeCharacter=async()=>{throw new Error("mapping service unavailable");};
  f.restart();
  f.afterCommitTimeout=false;
  await f.box.step({ accountId:1, id:row.id });
  assert.equal(f.box.get({ accountId:1, id:row.id }).state,"applied");
  assert.equal(f.box.get({ accountId:1, id:row.id }).realmAccountId,42);
  assert.equal(f.applyCount,1);
  assert.equal(f.ledger.balance(1),"30");
  assert.ok(f.commands.every(command => command.split(" ")[6] === "42"));
});

test("realm ownership proof is explicit, bounded and immutable in durable intents", async (t) => {
  const f = fixture(t);
  for(const realmAccountId of [undefined,null,0,-1,"42",42.5,4294967296]) {
    const box=new BridgeOutbox({...f.options,authorizeCharacter:async()=>({accountId:1,realmAccountId,guid:"7",moneyUnits:"50",online:false,loading:false})});
    try { await assert.rejects(grant(box)); } finally { box.close(); }
  }
  assert.equal(f.ledger.balance(1),"100");
  const row=await grant(f.box);
  const db=new DatabaseSync(f.options.dbPath);
  try { assert.throws(()=>db.prepare("UPDATE world_bridge_outbox SET realm_account_id=99 WHERE id=?").run(row.id),/immutable/i); } finally { db.close(); }
});

test("unversioned TEST outboxes fail closed without assuming their stored account IDs match realm IDs", (t) => {
  const dir=mkdtempSync(join(tmpdir(),"world-bridge-legacy-")),dbPath=join(dir,"test.sqlite"),ledger=new Ledger(dbPath);
  t.after(()=>{ledger.close();rmSync(dir,{recursive:true,force:true});});
  ledger.allocate(1,"100");
  const db=new DatabaseSync(dbPath);
  db.exec("CREATE TABLE world_bridge_outbox(id TEXT PRIMARY KEY,account_id INTEGER NOT NULL,request_key TEXT NOT NULL,guid TEXT NOT NULL,units TEXT NOT NULL,direction TEXT NOT NULL,expected_before TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL)");
  db.prepare("INSERT INTO world_bridge_outbox VALUES(?,?,?,?,?,?,?,?,?,?)").run("a".repeat(64),1,"old","7","70","grant","50","pending",null,0);
  db.close();
  assert.throws(()=>new BridgeOutbox({dbPath,phase:"TEST",transport:{execute:async()=>{}},authorizeCharacter:async()=>{}}),/schema|legacy|ambiguous|version/i);
  assert.equal(ledger.balance(1),"100");
  const check=new DatabaseSync(dbPath);
  try { assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='world_bridge_schema'").get().n,0);assert.equal(check.prepare("SELECT account_id FROM world_bridge_outbox").get().account_id,1); } finally { check.close(); }
});
