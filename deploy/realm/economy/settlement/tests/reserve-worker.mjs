import { SettlementEngine } from "../engine.mjs";
import {
  config,
  fakeRpc,
  pairs,
  treasury,
  destination,
  tokenInfo,
  NOW,
} from "./fixtures.mjs";

const rpc = fakeRpc();
rpc.tokens.set(treasury, tokenInfo(config.treasuryWallet, "100"));
const engine = await SettlementEngine.open({
  dbPath: process.argv[2],
  config,
  rpc,
  resolveWallet: async () => pairs[1].publicKey.toBase58(),
  now: () => NOW,
});
// Widen the scheduling window after a real balance read. SQLite's immediate lock must
// protect that read through the reservation write against the other OS process.
const read = engine.store.balance.bind(engine.store);
engine.store.balance = (id) => {
  const result = read(id);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
  return result;
};
process.on("message", async () => {
  try {
    await engine.reserveWithdrawal({
      accountId: 1,
      idempotencyKey: process.argv[3],
      atoms: "70",
      destinationTokenAccount: destination,
    });
    process.send({ reserved: true });
  } catch (error) {
    process.send({ reserved: false, error: error.message });
  } finally {
    engine.close();
    process.disconnect();
  }
});
process.send({ ready: true });
