import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { address, signingAddress, rawAtoms, safeInteger, signatureText, signatureOf, signedTransaction, MEMO_PROGRAM, TOKEN_PROGRAM } from './protocol.mjs';
import { validTransactionError } from '../../bridge/accounting/transaction-errors.mjs';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// Native SOL is transferred directly; no mint, token account or wrapped SOL is used.
export function nativeTransferTransaction({ wallet, destination, lamports, memo, blockhash }) {
  signingAddress(wallet);
  signingAddress(destination);
  address(blockhash);
  const amount = rawAtoms(lamports);
  if (new Set([wallet, destination, SYSTEM_PROGRAM, MEMO_PROGRAM, TOKEN_PROGRAM]).size !== 5)
    throw new Error('Distinct native transfer wallets required');
  if (typeof memo !== 'string' || !memo || Buffer.byteLength(memo, 'utf8') > 512 || Buffer.from(memo, 'utf8').toString('utf8') !== memo)
    throw new Error('Exact bounded UTF-8 memo required');
  return new Transaction({ feePayer: new PublicKey(wallet), recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: new PublicKey(destination), lamports: amount }),
    new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, 'utf8') }),
  );
}

// Account ownership comes from a trusted finalized account-info RPC at the adapter
// boundary; transaction receipts alone do not carry account ownership metadata.
export function decodeSystemAccount(info, { allowMissing = false } = {}) {
  if (info === null && allowMissing === true) return { lamports: '0' };
  if (!info || info.owner !== SYSTEM_PROGRAM || info.executable !== false || !Array.isArray(info.data) || info.data.length !== 2 || info.data[0] !== '' || info.data[1] !== 'base64')
    throw new Error('Ordinary empty System Program account required');
  return { lamports: String(safeInteger(info.lamports)) };
}

// Finalized status and matching status/receipt slots must be established by the
// caller. This pure proof checks signed bytes and every observable lamport delta.
export function verifyNativeTransferReceipt({ receipt, signature, intent, expectedFeeLamports, allowFailure = false }) {
  signatureText(signature);
  if (!receipt || receipt.version !== 'legacy' || !receipt.meta || !Array.isArray(receipt.transaction) || receipt.transaction.length !== 2 || receipt.transaction[1] !== 'base64' || typeof receipt.transaction[0] !== 'string')
    throw new Error('Full legacy native receipt required');
  safeInteger(receipt.slot);
  safeInteger(intent.createdSlot);
  if (receipt.slot < intent.createdSlot) throw new Error('Native transfer precedes intent');
  if (receipt.blockTime !== null) safeInteger(receipt.blockTime);
  if (intent.expiresAt !== undefined) {
    safeInteger(intent.expiresAt);
    safeInteger(receipt.blockTime);
    if (BigInt(receipt.blockTime) * 1000n > BigInt(intent.expiresAt)) throw new Error('Native transfer outside intent window');
  }
  const bytes = Buffer.from(receipt.transaction[0], 'base64');
  if (bytes.toString('base64') !== receipt.transaction[0]) throw new Error('Canonical native receipt bytes required');
  const tx = signedTransaction(bytes);
  if (signatureOf(tx) !== signature || tx.signatures[0].publicKey.toBase58() !== intent.wallet)
    throw new Error('Native signature/authority mismatch');
  const expected = nativeTransferTransaction({ ...intent, blockhash: tx.recentBlockhash });
  if (!tx.serializeMessage().equals(expected.serializeMessage())) throw new Error('Native signed transfer differs from intent');
  const keys = tx.compileMessage().accountKeys.map(key => key.toBase58());
  const meta = receipt.meta;
  if (!validTransactionError(meta.err, { instructionCount: tx.instructions.length, accountCount: keys.length })) throw new Error('Malformed native transaction error');
  const failed = meta.err !== null;
  if (failed && allowFailure !== true) throw new Error('Successful native receipt required');
  if (!Array.isArray(meta.innerInstructions) || meta.innerInstructions.some(row => !row || !Number.isInteger(row.index) || row.index < 0 || row.index >= tx.instructions.length || !Array.isArray(row.instructions) || row.instructions.length !== 0) || !Array.isArray(meta.preTokenBalances) || meta.preTokenBalances.length !== 0 || !Array.isArray(meta.postTokenBalances) || meta.postTokenBalances.length !== 0)
    throw new Error('Direct native transfer without CPI or token effects required');
  const fee = BigInt(safeInteger(meta.fee));
  if (expectedFeeLamports !== undefined && rawAtoms(expectedFeeLamports, { zero: true }) !== fee)
    throw new Error('Native transaction fee differs from quote');
  function balances(values) {
    if (!Array.isArray(values) || values.length !== keys.length) throw new Error('All native account balances required');
    return values.map(value => BigInt(safeInteger(value)));
  }
  const before = balances(meta.preBalances), after = balances(meta.postBalances), amount = rawAtoms(intent.lamports);
  for (let index = 0; index < keys.length; index++) {
    const expectedDelta = keys[index] === intent.wallet ? -fee - (failed ? 0n : amount) : keys[index] === intent.destination && !failed ? amount : 0n;
    if (after[index] - before[index] !== expectedDelta) throw new Error('Native account balance delta differs from transfer and fee');
  }
  return { lamports: amount.toString(), feeLamports: fee.toString(), slot: receipt.slot, failed };
}
