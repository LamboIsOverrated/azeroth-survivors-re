import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeMint,
  decodeTokenAccount,
  rawAtoms,
  verifyDepositReceipt,
  verifyTransferReceipt,
  signatureOf,
} from "../protocol.mjs";
import {
  config,
  mintInfo,
  tokenInfo,
  pairs,
  receipt,
  source,
  NOW,
  TOKEN,
} from "./fixtures.mjs";

test("raw u64 token amounts stay exact and reject overflow, floating point and TEST representations", () => {
  assert.equal(rawAtoms("18446744073709551615"), 18446744073709551615n);
  for (const amount of [
    "0",
    "18446744073709551616",
    "1.0",
    "1e9",
    "-1",
    "01",
    1,
    1n,
    "100 TEST",
  ])
    assert.throws(() => rawAtoms(amount));
});
test("mint and token account validation reject extensions, wrong programs, frozen/delegated assets and bad precision", () => {
  assert.equal(decodeMint(mintInfo(), 9).supply, "18446744073709551615");
  assert.equal(
    decodeTokenAccount(
      tokenInfo(config.treasuryWallet, "9007199254740993"),
      config.mint,
      config.treasuryWallet,
    ).atoms,
    "9007199254740993",
  );
  for (const changes of [
    { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" },
    { executable: true },
    { data: [Buffer.alloc(83).toString("base64"), "base64"] },
  ])
    assert.throws(() => decodeMint(mintInfo(changes), 9));
  assert.throws(() => decodeMint(mintInfo(), 8));
  for (const offset of [0, 46]) {
    const bytes = Buffer.from(mintInfo().data[0], "base64");
    bytes.writeUInt32LE(1, offset);
    assert.throws(() =>
      decodeMint(mintInfo({ data: [bytes.toString("base64"), "base64"] }), 9),
    );
  }
  for (const mutate of [
    (bytes) => {
      bytes[108] = 2;
    },
    (bytes) => {
      bytes.writeUInt32LE(1, 72);
    },
    (bytes) => {
      bytes.writeUInt32LE(1, 109);
    },
    (bytes) => {
      bytes[0] ^= 1;
    },
  ]) {
    const bytes = Buffer.from(
      tokenInfo(config.treasuryWallet).data[0],
      "base64",
    );
    mutate(bytes);
    assert.throws(() =>
      decodeTokenAccount(
        tokenInfo(config.treasuryWallet, "0", {
          data: [bytes.toString("base64"), "base64"],
        }),
        config.mint,
        config.treasuryWallet,
      ),
    );
  }
});

const intent = {
  id: "a".repeat(64),
  accountId: 1,
  wallet: pairs[1].publicKey.toBase58(),
  sourceTokenAccount: source,
  atoms: "9007199254740993",
  memo: `realm:v1:deposit:${"a".repeat(64)}`,
  createdSlot: 100,
  createdAt: NOW,
  expiresAt: NOW + 300000,
};
test('transfer receipts permit explicit null time while deposit receipts require a timestamp within expiry', () => {
  const {row,tx}=receipt(intent),signature=signatureOf(tx);
  row.blockTime=null;
  assert.equal(verifyTransferReceipt({receipt:row,signature,intent,config}).atoms,'9007199254740993');
  assert.throws(()=>verifyDepositReceipt({receipt:row,signature,intent,config}));
  for(const value of [undefined,'1700000000',false,{},-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
    row.blockTime=value;
    assert.throws(()=>verifyTransferReceipt({receipt:row,signature,intent,config}));
    assert.throws(()=>verifyDepositReceipt({receipt:row,signature,intent,config}));
  }
  row.blockTime=intent.expiresAt/1000+1;
  assert.equal(verifyTransferReceipt({receipt:row,signature,intent,config}).slot,120);
  assert.throws(()=>verifyDepositReceipt({receipt:row,signature,intent,config}));
});
test("deposit receipt verifies the actual signed raw transaction and exact token balance deltas", () => {
  const { row, tx } = receipt(intent);
  assert.equal(
    verifyDepositReceipt({
      receipt: row,
      signature: signatureOf(tx),
      intent,
      config,
    }).atoms,
    "9007199254740993",
  );
  const changes = [
    (r) => {
      r.meta.err = { InstructionError: [0, "bad"] };
    },
    (r) => {
      r.meta.postTokenBalances[1].uiTokenAmount.amount = "9007199254740992";
    },
    (r) => {
      r.meta.preTokenBalances[0].owner = config.treasuryWallet;
    },
    (r) => {
      r.meta.preTokenBalances[0].programId = "wrong";
    },
    (r) => {
      r.slot = 99;
    },
    (r) => {
      r.blockTime = (NOW + 300001) / 1000;
    },
    (r) => {
      r.meta.innerInstructions = [{ index: 0, instructions: [{}] }];
    },
    (r) => {
      r.version = 0;
    },
  ];
  for (const mutate of changes) {
    const changed = structuredClone(row);
    mutate(changed);
    assert.throws(() =>
      verifyDepositReceipt({
        receipt: changed,
        signature: signatureOf(tx),
        intent,
        config,
      }),
    );
  }
});

test("wrong mint, amount, memo, authority or extra instructions cannot pass deposit proof", () => {
  for (const change of [
    (tx) => {
      tx.instructions[0].data.writeBigUInt64LE(1n, 1);
    },
    (tx) => {
      tx.instructions[1].data = Buffer.from("other account intent");
    },
    (tx) => {
      tx.instructions.push(tx.instructions[1]);
    },
    (tx) => {
      tx.instructions[0].programId = pairs[0].publicKey;
    },
    (tx) => {
      tx.instructions[0].keys[1].pubkey = pairs[0].publicKey;
    },
  ]) {
    const { row, tx } = receipt(intent, { change });
    assert.throws(() =>
      verifyDepositReceipt({
        receipt: row,
        signature: signatureOf(tx),
        intent,
        config,
      }),
    );
  }
  const { row, tx } = receipt(intent);
  assert.throws(() =>
    verifyDepositReceipt({
      receipt: row,
      signature: signatureOf(tx),
      intent: { ...intent, wallet: config.treasuryWallet },
      config,
    }),
  );
  assert.throws(() =>
    verifyDepositReceipt({
      receipt: row,
      signature: "1".repeat(88),
      intent,
      config,
    }),
  );
});
