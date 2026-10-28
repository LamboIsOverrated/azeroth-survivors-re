import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Transaction } from "@solana/web3.js";
import { SettlementEngine } from "../engine.mjs";
import { Ledger } from "../../ledger.mjs";
import { signatureOf } from "../protocol.mjs";
import {
  config,
  fakeRpc,
  fixtureSigner,
  pairs,
  receipt,
  source,
  treasury,
  destination,
  tokenInfo,
  NOW,
  mint,
} from "./fixtures.mjs";

async function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "realm-live-engine-")),
    dbPath = join(dir, "settlement.sqlite");
  const rpc = fakeRpc(),
    options = {
      dbPath,
      config,
      rpc,
      archiveRpc: {
        sourceId: "archive-fixture",
        call: (method, params) => rpc.call(method, params),
      },
      signer: fixtureSigner,
      resolveWallet: async (id) =>
        id === 1
          ? pairs[1].publicKey.toBase58()
          : pairs[0].publicKey.toBase58(),
      now: () => NOW,
      ...overrides,
    };
  let engine = await SettlementEngine.open(options);
  const peers = [];
  t.after(() => {
    for (const peer of peers) peer.close();
    engine.close();
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });
  return {
    rpc,
    options,
    get engine() {
      return engine;
    },
    async openPeer() {
      const peer = await SettlementEngine.open(options);
      peers.push(peer);
      return peer;
    },
    async restart() {
      engine.close();
      engine = await SettlementEngine.open(options);
      return engine;
    },
  };
}
async function deposit(f, atoms = "100") {
  const intent = await f.engine.createDepositIntent({
    accountId: 1,
    atoms,
    sourceTokenAccount: source,
  });
  const { row, tx } = receipt(intent),
    signature = signatureOf(tx);
  f.rpc.receipts.set(signature, row);
  f.rpc.statuses.set(signature, {
    slot: row.slot,
    err: null,
    confirmationStatus: "finalized",
  });
  f.rpc.tokens.set(treasury, tokenInfo(config.treasuryWallet, atoms));
  await f.engine.confirmDeposit({
    accountId: 1,
    intentId: intent.id,
    signature,
  });
  return { intent, signature };
}
const withdraw = (engine) =>
  engine.reserveWithdrawal({
    accountId: 1,
    idempotencyKey: "withdraw-1",
    atoms: "70",
    destinationTokenAccount: destination,
  });

test("engine requires chain-validated immutable config and cannot inherit TEST journal claims", async (t) => {
  await assert.rejects(() =>
    SettlementEngine.open({
      dbPath: ":memory:",
      rpc: fakeRpc(),
      config: {},
      resolveWallet: async () => null,
    }),
  );
  const f = await fixture(t);
  const testVault = new Ledger(f.options.dbPath);
  testVault.allocate(1, "100");
  testVault.close();
  assert.deepEqual(f.engine.balance(1), {
    namespace: "LIVE_ATOMS",
    available: "0",
    reserved: "0",
  });
  const other = structuredClone(config);
  other.decimals = 8;
  await assert.rejects(() =>
    SettlementEngine.open({ ...f.options, config: other }),
  );
});

test("finalized deposit credits once across concurrent requests, account replay and restart", async (t) => {
  const f = await fixture(t),
    { intent, signature } = await deposit(f, "9007199254740993");
  await Promise.all([
    f.engine.confirmDeposit({ accountId: 1, intentId: intent.id, signature }),
    f.engine.confirmDeposit({ accountId: 1, intentId: intent.id, signature }),
  ]);
  await assert.rejects(() =>
    f.engine.confirmDeposit({ accountId: 2, intentId: intent.id, signature }),
  );
  await f.restart();
  await f.engine.confirmDeposit({
    accountId: 1,
    intentId: intent.id,
    signature,
  });
  assert.equal(f.engine.balance(1).available, "9007199254740993");
  assert.equal(f.engine.history(1).length, 1);
  assert.throws(
    () =>
      f.engine.db.prepare("UPDATE live_journal SET available_delta='0'").run(),
    /append.only/,
  );
});

test("pending, failed, wrong-slot, underfunded and mismatched receipts never create claims", async (t) => {
  const f = await fixture(t),
    intent = await f.engine.createDepositIntent({
      accountId: 1,
      atoms: "100",
      sourceTokenAccount: source,
    }),
    { row, tx } = receipt(intent),
    signature = signatureOf(tx);
  f.rpc.receipts.set(signature, row);
  f.rpc.statuses.set(signature, {
    slot: 120,
    err: null,
    confirmationStatus: "confirmed",
  });
  await assert.rejects(() =>
    f.engine.confirmDeposit({ accountId: 1, intentId: intent.id, signature }),
  );
  f.rpc.statuses.set(signature, {
    slot: 120,
    err: null,
    confirmationStatus: "finalized",
  });
  await assert.rejects(() =>
    f.engine.confirmDeposit({ accountId: 1, intentId: intent.id, signature }),
  );
  f.rpc.tokens.set(treasury, tokenInfo(config.treasuryWallet, "100"));
  f.rpc.statuses.set(signature, {
    slot: 119,
    err: null,
    confirmationStatus: "finalized",
  });
  await assert.rejects(() =>
    f.engine.confirmDeposit({ accountId: 1, intentId: intent.id, signature }),
  );
  assert.equal(f.engine.balance(1).available, "0");
});

test("withdrawal reserves before signing, rejects competing claims, persists bytes before uncertain broadcast", async (t) => {
  const f = await fixture(t);
  await deposit(f);
  const results = await Promise.allSettled([
    withdraw(f.engine),
    f.engine.reserveWithdrawal({
      accountId: 1,
      idempotencyKey: "withdraw-2",
      atoms: "70",
      destinationTokenAccount: destination,
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const row = results.find((r) => r.status === "fulfilled").value;
  assert.deepEqual(f.engine.balance(1), {
    namespace: "LIVE_ATOMS",
    available: "30",
    reserved: "70",
  });
  const prepared = await f.engine.prepareWithdrawal({
    accountId: 1,
    withdrawalId: row.id,
  });
  assert.equal(prepared.state, "signed");
  assert.ok(prepared.signature);
  const before = f.engine.getWithdrawal({ accountId: 1, withdrawalId: row.id });
  assert.ok(before.signedTransaction);
  f.rpc.failSend = true;
  const sent = await f.engine.broadcastWithdrawal({
    accountId: 1,
    withdrawalId: row.id,
  });
  assert.equal(sent.state, "pending");
  await f.restart();
  assert.equal(
    f.engine.getWithdrawal({ accountId: 1, withdrawalId: row.id })
      .signedTransaction,
    before.signedTransaction,
  );
  assert.equal(f.engine.balance(1).reserved, "70");
  assert.throws(() =>
    f.engine.getWithdrawal({ accountId: 2, withdrawalId: row.id }),
  );
});

test("finalized success settles once and finalized failure releases only once", async (t) => {
  for (const success of [true, false]) {
    const f = await fixture(t);
    await deposit(f);
    const row = await withdraw(f.engine);
    const prepared = await f.engine.prepareWithdrawal({
      accountId: 1,
      withdrawalId: row.id,
    });
    f.rpc.slot = 180;
    f.rpc.statuses.set(prepared.signature, {
      slot: 160,
      err: success ? null : { InstructionError: [0, "failed"] },
      confirmationStatus: "finalized",
    });
    const settled = await f.engine.reconcileWithdrawal({
      accountId: 1,
      withdrawalId: row.id,
    });
    assert.equal(settled.state, success ? "settled" : "failed");
    await f.restart();
    await f.engine.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id });
    assert.equal(f.engine.balance(1).available, success ? "30" : "100");
    assert.equal(f.engine.balance(1).reserved, "0");
    assert.equal(f.engine.history(1).length, 3);
  }
});

test("uncertain status never releases; proven finalized blockhash expiry plus full-history absence releases once", async (t) => {
  const f = await fixture(t);
  await deposit(f);
  const row = await withdraw(f.engine),
    prepared = await f.engine.prepareWithdrawal({
      accountId: 1,
      withdrawalId: row.id,
    });
  f.rpc.slot = 180;
  f.rpc.height = 250;
  f.rpc.valid = true;
  assert.equal(
    (await f.engine.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id }))
      .state,
    "signed",
  );
  assert.equal(f.engine.balance(1).reserved, "70");
  f.rpc.valid = false;
  f.rpc.statuses.set(prepared.signature, {
    slot: 170,
    err: { InstructionError: [0, "maybe-failed"] },
    confirmationStatus: "processed",
  });
  assert.equal(
    (await f.engine.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id }))
      .state,
    "signed",
  );
  f.rpc.statuses.delete(prepared.signature);
  assert.equal(
    (await f.engine.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id }))
      .state,
    "expired",
  );
  await f.engine.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id });
  assert.equal(f.engine.balance(1).available, "100");
  assert.ok(
    f.rpc.calls.some(
      (call) =>
        call.method === "getSignatureStatuses" &&
        call.params[1].searchTransactionHistory === true,
    ),
  );
});

test("signer cannot change amount, destination, fee payer, blockhash or instructions", async (t) => {
  const signer = {
    signTransaction: async (bytes) => {
      const tx = Transaction.from(bytes);
      tx.instructions[0].data.writeBigUInt64LE(71n, 1);
      return fixtureSigner.signTransaction(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
    },
  };
  const f = await fixture(t, { signer });
  await deposit(f);
  const row = await withdraw(f.engine);
  await assert.rejects(() =>
    f.engine.prepareWithdrawal({ accountId: 1, withdrawalId: row.id }),
  );
  assert.equal(
    f.engine.getWithdrawal({ accountId: 1, withdrawalId: row.id }).state,
    "reserved",
  );
  assert.equal(f.engine.balance(1).reserved, "70");
  assert.equal(
    f.rpc.calls.filter((call) => call.method === "sendTransaction").length,
    0,
  );
});

test("a second ledger connection sees the reserve before signer and signed bytes before RPC", async (t) => {
  const f = await fixture(t);
  await deposit(f);
  const reader = await f.openPeer();
  const originalSigner = f.engine.signer;
  f.engine.signer = {
    signTransaction: async (bytes) => {
      assert.deepEqual(reader.balance(1), {
        namespace: "LIVE_ATOMS",
        available: "30",
        reserved: "70",
      });
      return originalSigner.signTransaction(bytes);
    },
  };
  const row = await withdraw(f.engine);
  await f.engine.prepareWithdrawal({ accountId: 1, withdrawalId: row.id });
  const rpcCall = f.rpc.call;
  f.rpc.call = async (method, params) => {
    if (method === "sendTransaction") {
      const persisted = reader.getWithdrawal({
        accountId: 1,
        withdrawalId: row.id,
      });
      assert.equal(persisted.state, "pending");
      assert.equal(persisted.signedTransaction, params[0]);
      assert.equal(
        persisted.signature,
        signatureOf(Transaction.from(Buffer.from(params[0], "base64"))),
      );
      return persisted.signature;
    }
    return rpcCall(method, params);
  };
  await f.engine.broadcastWithdrawal({ accountId: 1, withdrawalId: row.id });
  assert.equal(reader.balance(1).reserved, "70");
  assert.throws(
    () =>
      f.engine.db
        .prepare(
          "UPDATE live_withdrawals SET signed_transaction='different' WHERE id=?",
        )
        .run(row.id),
    /immutable/,
  );
});

test("competing engine connections settle/release exactly once and idempotency cannot redirect payment", async (t) => {
  const f = await fixture(t);
  await deposit(f);
  const reader = await f.openPeer();
  const results = await Promise.allSettled([
    withdraw(f.engine),
    reader.reserveWithdrawal({
      accountId: 1,
      idempotencyKey: "other-worker",
      atoms: "70",
      destinationTokenAccount: destination,
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const row = results.find((result) => result.status === "fulfilled").value;
  const current = await f.engine.reserveWithdrawal({
    accountId: 1,
    idempotencyKey:
      row.id === results[0].value?.id ? "withdraw-1" : "other-worker",
    atoms: "70",
    destinationTokenAccount: destination,
  });
  assert.equal(current.id, row.id);
  await assert.rejects(() =>
    f.engine.reserveWithdrawal({
      accountId: 1,
      idempotencyKey: "withdraw-1",
      atoms: "71",
      destinationTokenAccount: destination,
    }),
  );
  await assert.rejects(() =>
    reader.prepareWithdrawal({ accountId: 2, withdrawalId: row.id }),
  );
  const prepared = await f.engine.prepareWithdrawal({
    accountId: 1,
    withdrawalId: row.id,
  });
  f.rpc.slot = 180;
  f.rpc.statuses.set(prepared.signature, {
    slot: 160,
    err: null,
    confirmationStatus: "finalized",
  });
  await Promise.all([
    reader.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id }),
    f.engine.reconcileWithdrawal({ accountId: 1, withdrawalId: row.id }),
  ]);
  assert.equal(f.engine.balance(1).reserved, "0");
  assert.equal(f.engine.balance(1).available, "30");
  assert.equal(reader.history(1).length, 3);
});

test("restart discovers unsent reservations and always rebroadcasts the same persisted signed bytes", async (t) => {
  const f = await fixture(t);
  await deposit(f);
  const row = await withdraw(f.engine);
  await f.restart();
  assert.equal(f.engine.pendingWithdrawals()[0].state, "reserved");
  const prepared = await f.engine.prepareWithdrawal({
    accountId: 1,
    withdrawalId: row.id,
  });
  f.rpc.failSend = true;
  await f.engine.broadcastWithdrawal({ accountId: 1, withdrawalId: row.id });
  await f.restart();
  await f.engine.broadcastWithdrawal({ accountId: 1, withdrawalId: row.id });
  const sent = f.rpc.calls.filter((call) => call.method === "sendTransaction");
  assert.equal(sent.length, 2);
  assert.equal(sent[0].params[0], prepared.signedTransaction);
  assert.equal(sent[1].params[0], prepared.signedTransaction);
  assert.equal(f.engine.pendingWithdrawals()[0].signature, prepared.signature);
});

test("expiry never releases on missing witness, pruned history, contradictory status or RPC error", async (t) => {
  for (const problem of [
    "no-archive",
    "pruned",
    "contradictory",
    "rpc-error",
  ]) {
    const f = await fixture(t);
    await deposit(f);
    const row = await withdraw(f.engine);
    const prepared = await f.engine.prepareWithdrawal({
      accountId: 1,
      withdrawalId: row.id,
    });
    f.rpc.slot = 180;
    f.rpc.height = 250;
    f.rpc.valid = false;
    if (problem === "no-archive") f.engine.archiveRpc = undefined;
    else {
      const call = f.rpc.call;
      f.engine.archiveRpc.call = async (method, params) => {
        if (problem === "pruned" && method === "getFirstAvailableBlock")
          return 151;
        if (problem === "contradictory" && method === "getSignatureStatuses")
          return {
            context: { slot: 180 },
            value: [{ slot: 170, confirmationStatus: "finalized", err: null }],
          };
        if (problem === "rpc-error")
          throw new Error("history provider unavailable");
        return call(method, params);
      };
    }
    const result = await f.engine.reconcileWithdrawal({
      accountId: 1,
      withdrawalId: row.id,
    });
    assert.equal(result.signature, prepared.signature);
    assert.equal(f.engine.balance(1).reserved, "70");
    assert.equal(f.engine.balance(1).available, "30");
  }
});

test("reserve shortfall freezes signing and first broadcast without releasing the customer claim", async (t) => {
  for (const stage of ["sign", "broadcast"]) {
    const f = await fixture(t);
    await deposit(f);
    const row = await withdraw(f.engine);
    if (stage === "broadcast")
      await f.engine.prepareWithdrawal({ accountId: 1, withdrawalId: row.id });
    f.rpc.tokens.set(treasury, tokenInfo(config.treasuryWallet, "80"));
    await assert.rejects(() =>
      stage === "sign"
        ? f.engine.prepareWithdrawal({ accountId: 1, withdrawalId: row.id })
        : f.engine.broadcastWithdrawal({ accountId: 1, withdrawalId: row.id }),
    );
    assert.equal(f.engine.balance(1).reserved, "70");
    assert.equal(
      f.rpc.calls.filter((call) => call.method === "sendTransaction").length,
      0,
    );
    assert.equal(
      f.engine.getWithdrawal({ accountId: 1, withdrawalId: row.id }).state,
      stage === "sign" ? "reserved" : "signed",
    );
  }
});

test("LIVE journal supports token amounts above signed SQLite range without converting to numbers", async (t) => {
  const f = await fixture(t),
    atoms = "18446744073709551614";
  await deposit(f, atoms);
  const row = await f.engine.reserveWithdrawal({
    accountId: 1,
    idempotencyKey: "u64-withdrawal",
    atoms,
    destinationTokenAccount: destination,
  });
  assert.equal(f.engine.balance(1).reserved, atoms);
  assert.equal(f.engine.balance(1).available, "0");
  const prepared = await f.engine.prepareWithdrawal({
    accountId: 1,
    withdrawalId: row.id,
  });
  const tx = Transaction.from(
    Buffer.from(prepared.signedTransaction, "base64"),
  );
  assert.equal(
    tx.instructions[0].data.readBigUInt64LE(1),
    18446744073709551614n,
  );
  await f.restart();
  assert.equal(f.engine.balance(1).reserved, atoms);
});

test("an existing database rejects a different network even when the replacement RPC agrees", async (t) => {
  const f = await fixture(t);
  await deposit(f);
  const changed = { ...config, genesisHash: pairs[0].publicKey.toBase58() },
    call = f.rpc.call;
  const rpc = {
    sourceId: "replacement-primary",
    call: (method, params) =>
      method === "getGenesisHash"
        ? Promise.resolve(changed.genesisHash)
        : call(method, params),
  };
  await assert.rejects(
    () =>
      SettlementEngine.open({
        ...f.options,
        config: changed,
        rpc,
        archiveRpc: undefined,
      }),
    /cannot change/,
  );
  assert.equal(f.engine.balance(1).available, "100");
});

test("runtime mint/network configuration cannot be replaced after validation", async (t) => {
  const f = await fixture(t);
  assert.throws(() => {
    f.engine.config = { ...config, mint: pairs[0].publicKey.toBase58() };
  });
  assert.throws(() => {
    f.engine.config.decimals = 8;
  });
});

test(
  "different OS processes cannot reserve overlapping LIVE claims",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await deposit(f);
    const workers = [],
      exits = [];
    try {
      const ready = [],
        results = [];
      for (const id of ["os-worker-a", "os-worker-b"]) {
        const worker = fork(
          new URL("./reserve-worker.mjs", import.meta.url),
          [f.options.dbPath, id],
          { silent: true },
        );
        workers.push(worker);
        exits.push(once(worker, "exit"));
        ready.push(
          new Promise((resolve, reject) => {
            worker.once("message", (message) =>
              message.ready
                ? resolve()
                : reject(new Error("worker failed to initialize")),
            );
            worker.on("error", reject);
          }),
        );
        results.push(
          new Promise((resolve, reject) => {
            worker.on("message", (message) => {
              if ("reserved" in message) resolve(message.reserved);
            });
            worker.on("error", reject);
          }),
        );
      }
      await Promise.all(ready);
      for (const worker of workers) worker.send({ reserve: true });
      assert.equal((await Promise.all(results)).filter(Boolean).length, 1);
      await Promise.all(exits);
      assert.deepEqual(f.engine.balance(1), {
        namespace: "LIVE_ATOMS",
        available: "30",
        reserved: "70",
      });
      assert.equal(f.engine.history(1).length, 2);
    } finally {
      for (const worker of workers) if (worker.exitCode === null) worker.kill();
      await Promise.allSettled(exits);
    }
  },
);
