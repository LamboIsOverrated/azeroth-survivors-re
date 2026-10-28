import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const MAX_U64 = 18446744073709551615n;
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function address(value) {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 44 ||
    new PublicKey(value).toBase58() !== value
  )
    throw new Error("Invalid canonical address");
  return value;
}
export function signingAddress(value) {
  address(value);
  if (!PublicKey.isOnCurve(new PublicKey(value).toBytes()))
    throw new Error("Signing wallet required");
  return value;
}
export function rawAtoms(value, { zero = false } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value))
    throw new Error("Raw integer atom string required");
  const atoms = BigInt(value);
  if (atoms > MAX_U64 || (!zero && atoms === 0n))
    throw new Error("Amount outside raw u64 range");
  return atoms;
}
export function safeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid RPC integer");
  return value;
}
export function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`),
    text = "";
  while (value) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = "1" + text;
  }
  return text;
}
export function signatureOf(tx) {
  if (!tx.signature || tx.signature.length !== 64)
    throw new Error("Missing transaction signature");
  return base58(tx.signature);
}
export function signatureText(value) {
  if (
    typeof value !== "string" ||
    value.length < 64 ||
    value.length > 88 ||
    ![...value].every((char) => ALPHABET.includes(char))
  )
    throw new Error("Invalid signature");
  return value;
}
function accountBytes(info, size) {
  if (
    !info ||
    info.owner !== TOKEN_PROGRAM ||
    info.executable !== false ||
    !Array.isArray(info.data) ||
    info.data.length !== 2 ||
    info.data[1] !== "base64" ||
    typeof info.data[0] !== "string"
  )
    throw new Error("Conventional SPL account required");
  const bytes = Buffer.from(info.data[0], "base64");
  if (bytes.length !== size || bytes.toString("base64") !== info.data[0])
    throw new Error("Invalid conventional SPL account length");
  return bytes;
}
export function decodeMint(info, decimals) {
  const bytes = accountBytes(info, 82);
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    bytes[44] !== decimals ||
    bytes[45] !== 1 ||
    bytes.readUInt32LE(0) !== 0 ||
    bytes.readUInt32LE(46) !== 0
  )
    throw new Error(
      "Mint must be initialized, fixed-supply, unfrozen and match precision",
    );
  return { decimals, supply: bytes.readBigUInt64LE(36).toString() };
}
export function decodeTokenAccount(info, mint, wallet) {
  const bytes = accountBytes(info, 165);
  if (
    new PublicKey(bytes.subarray(0, 32)).toBase58() !== mint ||
    new PublicKey(bytes.subarray(32, 64)).toBase58() !== wallet ||
    bytes[108] !== 1 ||
    bytes.readUInt32LE(72) !== 0 ||
    bytes.readUInt32LE(109) !== 0 ||
    bytes.readUInt32LE(129) !== 0
  )
    throw new Error(
      "Token account must match mint/wallet, be initialized, non-native and have no delegate or close authority",
    );
  return { atoms: bytes.readBigUInt64LE(64).toString() };
}
export function transferTransaction({
  wallet,
  source,
  mint,
  destination,
  atoms,
  decimals,
  memo,
  blockhash,
}) {
  signingAddress(wallet);
  for (const value of [source, mint, destination, blockhash]) address(value);
  if (
    new Set([wallet, source, mint, destination, TOKEN_PROGRAM, MEMO_PROGRAM])
      .size !== 6
  )
    throw new Error("Transfer accounts must be distinct");
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(rawAtoms(atoms), 1);
  data[9] = decimals;
  return new Transaction({
    feePayer: new PublicKey(wallet),
    recentBlockhash: blockhash,
  }).add(
    new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM),
      keys: [
        { pubkey: new PublicKey(source), isSigner: false, isWritable: true },
        { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
        {
          pubkey: new PublicKey(destination),
          isSigner: false,
          isWritable: true,
        },
        { pubkey: new PublicKey(wallet), isSigner: true, isWritable: false },
      ],
      data,
    }),
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM),
      keys: [],
      data: Buffer.from(memo, "utf8"),
    }),
  );
}
export function signedTransaction(raw) {
  if (!(raw instanceof Uint8Array) || raw.length < 1 || raw.length > 1232)
    throw new Error("Invalid transaction bytes");
  const tx = Transaction.from(raw);
  if (
    tx.signatures.length !== 1 ||
    !tx.verifySignatures(true) ||
    !tx.serialize().equals(Buffer.from(raw))
  )
    throw new Error("Transaction signature verification failed");
  return tx;
}

export function verifyDepositReceipt({ receipt, signature, intent, config }) {
  signatureText(signature);
  if (
    !receipt ||
    receipt.version !== "legacy" ||
    !receipt.meta ||
    receipt.meta.err !== null ||
    !Array.isArray(receipt.transaction) ||
    receipt.transaction.length !== 2 ||
    receipt.transaction[1] !== "base64" ||
    typeof receipt.transaction[0] !== "string" ||
    !Array.isArray(receipt.meta.innerInstructions) ||
    receipt.meta.innerInstructions.some(
      (row) => !Array.isArray(row.instructions) || row.instructions.length,
    )
  )
    throw new Error("Successful direct legacy receipt required");
  safeInteger(receipt.slot);
  safeInteger(receipt.blockTime);
  if (
    receipt.slot < intent.createdSlot ||
    receipt.blockTime * 1000 > intent.expiresAt
  )
    throw new Error("Deposit outside intent window");
  const bytes = Buffer.from(receipt.transaction[0], "base64");
  if (bytes.toString("base64") !== receipt.transaction[0])
    throw new Error("Invalid receipt encoding");
  const tx = signedTransaction(bytes);
  if (
    signatureOf(tx) !== signature ||
    tx.signatures[0].publicKey.toBase58() !== intent.wallet
  )
    throw new Error("Signature/authority mismatch");
  const expected = transferTransaction({
    wallet: intent.wallet,
    source: intent.sourceTokenAccount,
    mint: config.mint,
    destination: config.treasuryTokenAccount,
    atoms: intent.atoms,
    decimals: config.decimals,
    memo: intent.memo,
    blockhash: tx.recentBlockhash,
  });
  if (!tx.serializeMessage().equals(expected.serializeMessage()))
    throw new Error("Receipt differs from intent transfer");
  const keys = tx.compileMessage().accountKeys.map((key) => key.toBase58());
  function amounts(rows) {
    if (!Array.isArray(rows) || rows.length !== 2)
      throw new Error("Exact source/destination token balances required");
    const result = new Map();
    for (const row of rows) {
      safeInteger(row.accountIndex);
      const key = keys[row.accountIndex];
      const owner =
        key === intent.sourceTokenAccount
          ? intent.wallet
          : key === config.treasuryTokenAccount
            ? config.treasuryWallet
            : null;
      if (
        !owner ||
        result.has(key) ||
        row.mint !== config.mint ||
        row.owner !== owner ||
        row.programId !== TOKEN_PROGRAM ||
        row.uiTokenAmount?.decimals !== config.decimals
      )
        throw new Error("Receipt token ownership/mint/program mismatch");
      result.set(key, rawAtoms(row.uiTokenAmount.amount, { zero: true }));
    }
    return result;
  }
  const pre = amounts(receipt.meta.preTokenBalances),
    post = amounts(receipt.meta.postTokenBalances),
    atoms = rawAtoms(intent.atoms);
  if (
    pre.get(intent.sourceTokenAccount) - post.get(intent.sourceTokenAccount) !==
      atoms ||
    post.get(config.treasuryTokenAccount) -
      pre.get(config.treasuryTokenAccount) !==
      atoms
  )
    throw new Error("Receipt amount deltas do not match");
  return { atoms: atoms.toString(), slot: receipt.slot };
}
