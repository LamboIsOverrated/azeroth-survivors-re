import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

// Published RFC 8032 vectors, exclusively for offline fixture signatures. No generated wallet or secret.
const seeds = [
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
];
export const pairs = seeds.map((seed) => {
  const privateKey = createPrivateKey({
    key: Buffer.from(`302e020100300506032b657004220420${seed}`, "hex"),
    format: "der",
    type: "pkcs8",
  });
  return {
    privateKey,
    publicKey: new PublicKey(
      createPublicKey(privateKey)
        .export({ type: "spki", format: "der" })
        .subarray(-32),
    ),
  };
});
const address = (n) => new PublicKey(Buffer.alloc(32, n)).toBase58();
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const mint = address(7),
  source = address(8),
  treasury = address(9),
  destination = address(10),
  blockhash = address(11),
  genesisHash = address(12);
export const config = {
  mint,
  treasuryWallet: pairs[0].publicKey.toBase58(),
  treasuryTokenAccount: treasury,
  genesisHash,
  decimals: 9,
};
export const NOW = 1800000000000;
export function mintInfo(overrides = {}) {
  const bytes = Buffer.alloc(82);
  bytes.writeBigUInt64LE(18446744073709551615n, 36);
  bytes[44] = 9;
  bytes[45] = 1;
  return {
    executable: false,
    owner: TOKEN,
    data: [bytes.toString("base64"), "base64"],
    ...overrides,
  };
}
export function tokenInfo(owner, atoms = "0", overrides = {}) {
  const bytes = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(bytes, 0);
  new PublicKey(owner).toBuffer().copy(bytes, 32);
  bytes.writeBigUInt64LE(BigInt(atoms), 64);
  bytes[108] = 1;
  return {
    executable: false,
    owner: TOKEN,
    data: [bytes.toString("base64"), "base64"],
    ...overrides,
  };
}
export function transfer({
  owner,
  sourceAccount = source,
  destinationAccount = treasury,
  amount = "100",
  memo,
  mintAddress = mint,
  tokenProgram = TOKEN,
  decimal = 9,
  recentBlockhash = blockhash,
}) {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(BigInt(amount), 1);
  data[9] = decimal;
  return new Transaction({
    feePayer: new PublicKey(owner),
    recentBlockhash,
  }).add(
    new TransactionInstruction({
      programId: new PublicKey(tokenProgram),
      keys: [
        {
          pubkey: new PublicKey(sourceAccount),
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: new PublicKey(mintAddress),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: new PublicKey(destinationAccount),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
      ],
      data,
    }),
    new TransactionInstruction({
      programId: new PublicKey(MEMO),
      keys: [],
      data: Buffer.from(memo),
    }),
  );
}
export function signFixture(tx, pair) {
  tx.addSignature(
    pair.publicKey,
    sign(null, tx.serializeMessage(), pair.privateKey),
  );
  return tx;
}
export function receipt(
  intent,
  { amount = intent.atoms, change = () => {} } = {},
) {
  const tx = transfer({
    owner: intent.wallet,
    sourceAccount: intent.sourceTokenAccount,
    amount,
    memo: intent.memo,
  });
  change(tx);
  signFixture(tx, pairs[1]);
  const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58());
  const balance = (account, owner, atoms) => ({
    accountIndex: keys.indexOf(account),
    mint,
    owner,
    programId: TOKEN,
    uiTokenAmount: { amount: String(atoms), decimals: 9 },
  });
  const row = {
    slot: 120,
    blockTime: NOW / 1000,
    version: "legacy",
    transaction: [tx.serialize().toString("base64"), "base64"],
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [
        balance(source, intent.wallet, BigInt(amount) + 1n),
        balance(treasury, config.treasuryWallet, 0n),
      ],
      postTokenBalances: [
        balance(source, intent.wallet, 1n),
        balance(treasury, config.treasuryWallet, amount),
      ],
    },
  };
  return { row, tx };
}
export function fakeRpc() {
  const rpc = {
    sourceId: "primary-fixture",
    calls: [],
    tokens: new Map([
      [
        source,
        tokenInfo(pairs[1].publicKey.toBase58(), "18446744073709551615"),
      ],
      [treasury, tokenInfo(config.treasuryWallet, "0")],
      [destination, tokenInfo(pairs[1].publicKey.toBase58(), "0")],
    ]),
    receipts: new Map(),
    statuses: new Map(),
    height: 130,
    valid: true,
    failSend: false,
    sendResult: null,
    slot: 150,
  };
  rpc.call = async (method, params) => {
    rpc.calls.push({ method, params });
    if (method === "getGenesisHash") return genesisHash;
    if (method === "getSlot") return 100;
    if (method === "getAccountInfo")
      return {
        context: { slot: rpc.slot },
        value:
          params[0] === mint ? mintInfo() : (rpc.tokens.get(params[0]) ?? null),
      };
    if (method === "getSignatureStatuses")
      return {
        context: { slot: rpc.slot },
        value: params[0].map(
          (signature) => rpc.statuses.get(signature) ?? null,
        ),
      };
    if (method === "getTransaction") return rpc.receipts.get(params[0]) ?? null;
    if (method === "getLatestBlockhash")
      return {
        context: { slot: rpc.slot },
        value: { blockhash, lastValidBlockHeight: 200 },
      };
    if (method === "getBlockHeight") return rpc.height;
    if (method === "isBlockhashValid")
      return { context: { slot: rpc.slot }, value: rpc.valid };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "sendTransaction") {
      if (rpc.failSend) throw new Error("ambiguous RPC timeout");
      return rpc.sendResult;
    }
    throw new Error(`Unexpected fixture RPC ${method}`);
  };
  return rpc;
}
export const fixtureSigner = {
  signTransaction: async (bytes) =>
    signFixture(Transaction.from(bytes), pairs[0]).serialize(),
};
