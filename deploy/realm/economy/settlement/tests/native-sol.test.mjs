import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { pairs, signFixture, blockhash, NOW } from './fixtures.mjs';
import { signatureOf, TOKEN_PROGRAM, MEMO_PROGRAM } from '../protocol.mjs';

// A missing implementation is an assertion failure in the initial RED run.
const native = await import('../native-sol.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/native-sol.mjs')) return {};
  throw error;
});
const { nativeTransferTransaction, decodeSystemAccount, verifyNativeTransferReceipt } = native;
const implemented = typeof nativeTransferTransaction === 'function';
const SYSTEM = '11111111111111111111111111111111';
const wallet = pairs[1].publicKey.toBase58();
const destination = pairs[0].publicKey.toBase58();
const intent = { wallet, destination, lamports: '10000', memo: 'realm-native:bound-intent', createdSlot: 100, expiresAt: NOW + 300000 };

function independentTransaction(fields = {}) {
  const input = { ...intent, blockhash, ...fields };
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2);
  data.writeBigUInt64LE(BigInt(input.lamports), 4);
  return new Transaction({ feePayer: new PublicKey(input.wallet), recentBlockhash: input.blockhash }).add(
    new TransactionInstruction({ programId: new PublicKey(SYSTEM), keys: [
      { pubkey: new PublicKey(input.wallet), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(input.destination), isSigner: false, isWritable: true },
    ], data }),
    new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(input.memo) }),
  );
}

function receiptFixture({ fields = {}, fee = 5000, error = null, mutate = () => {} } = {}) {
  const tx = independentTransaction(fields);
  mutate(tx);
  signFixture(tx, pairs[1]);
  const keys = tx.compileMessage().accountKeys.map(key => key.toBase58());
  const pre = keys.map(key => key === wallet ? 200000 : key === destination ? 100000 : 1);
  const post = [...pre];
  post[keys.indexOf(wallet)] -= fee + (error === null ? 10000 : 0);
  if (error === null) post[keys.indexOf(destination)] += 10000;
  return { tx, signature: signatureOf(tx), receipt: {
    slot: 120, blockTime: NOW / 1000, version: 'legacy', transaction: [tx.serialize().toString('base64'), 'base64'],
    meta: { err: error, fee, innerInstructions: [], preTokenBalances: [], postTokenBalances: [], preBalances: pre, postBalances: post },
  } };
}

function verify(fixture, extra = {}) {
  return verifyNativeTransferReceipt({ ...fixture, intent, ...extra });
}

test('native SOL protocol exports exist before any custody integration can use them', () => {
  assert.equal(typeof nativeTransferTransaction, 'function');
  assert.equal(typeof decodeSystemAccount, 'function');
  assert.equal(typeof verifyNativeTransferReceipt, 'function');
});

test('native transfer encodes exact u64 lamports with one source signer and a bound memo', { skip: !implemented }, () => {
  const tx = nativeTransferTransaction({ ...intent, blockhash });
  assert.equal(tx.feePayer.toBase58(), wallet);
  assert.equal(tx.instructions.length, 2);
  assert.equal(tx.instructions[0].programId.toBase58(), SYSTEM);
  assert.equal(tx.instructions[0].data.toString('hex'), '020000001027000000000000');
  assert.deepEqual(tx.instructions[0].keys.map(key => [key.pubkey.toBase58(), key.isSigner, key.isWritable]), [[wallet, true, true], [destination, false, true]]);
  assert.equal(tx.instructions[1].programId.toBase58(), MEMO_PROGRAM);
  assert.equal(tx.instructions[1].data.toString('utf8'), intent.memo);
  assert.equal(tx.compileMessage().header.numRequiredSignatures, 1);
  const maximum = nativeTransferTransaction({ ...intent, blockhash, lamports: '18446744073709551615' });
  assert.equal(maximum.instructions[0].data.subarray(4).toString('hex'), 'ffffffffffffffff');
});

test('native transfer rejects float/scientific/rounded amounts, self transfers and unbound memos', { skip: !implemented }, () => {
  for (const lamports of [0, 1, '0', '01', '1.1', '1e3', '-1', '18446744073709551616']) assert.throws(() => nativeTransferTransaction({ ...intent, blockhash, lamports }));
  for (const memo of ['', '\ud800', 'a'.repeat(513)]) assert.throws(() => nativeTransferTransaction({ ...intent, blockhash, memo }));
  for (const value of [wallet, SYSTEM, MEMO_PROGRAM, TOKEN_PROGRAM]) assert.throws(() => nativeTransferTransaction({ ...intent, blockhash, destination: value }));
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('native-destination')], new PublicKey(SYSTEM));
  assert.throws(() => nativeTransferTransaction({ ...intent, blockhash, destination: pda.toBase58() }));
});

test('system account proof requires safe lamports, empty data and the system owner', { skip: !implemented }, () => {
  const account = { owner: SYSTEM, executable: false, data: ['', 'base64'], lamports: 1234567890 };
  assert.deepEqual(decodeSystemAccount(account), { lamports: '1234567890' });
  assert.throws(() => decodeSystemAccount(null));
  assert.deepEqual(decodeSystemAccount(null, { allowMissing: true }), { lamports: '0' });
  for (const change of [{ owner: TOKEN_PROGRAM }, { executable: true }, { data: ['AA==', 'base64'] }, { data: ['', 'base58'] }, { lamports: '1' }, { lamports: 1.1 }, { lamports: -1 }, { lamports: 9007199254740992 }]) assert.throws(() => decodeSystemAccount({ ...account, ...change }));
});

test('native receipt proves actual signature, exact payment, fee and every account delta', { skip: !implemented }, () => {
  assert.deepEqual(verify(receiptFixture()), { lamports: '10000', feeLamports: '5000', slot: 120, failed: false });
  assert.deepEqual(verify(receiptFixture(), { expectedFeeLamports: '5000' }), { lamports: '10000', feeLamports: '5000', slot: 120, failed: false });
  assert.throws(() => verify(receiptFixture(), { expectedFeeLamports: '5001' }));
  assert.throws(() => verify(receiptFixture(), { expectedFeeLamports: 5000 }));
});

test('signed wrong amount, destination, memo, instruction order and extra instructions are refused', { skip: !implemented }, () => {
  const wrongDestination = new PublicKey(Buffer.alloc(32, 5)).toBase58();
  for (const fields of [{ lamports: '9999' }, { destination: wrongDestination }, { memo: 'different-intent' }]) assert.throws(() => verify(receiptFixture({ fields })));
  assert.throws(() => verify(receiptFixture({ mutate: tx => tx.instructions.reverse() })));
  assert.throws(() => verify(receiptFixture({ mutate: tx => tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from('extra') })) })));
  assert.throws(() => verify(receiptFixture({ mutate: tx => { tx.instructions[0].programId = new PublicKey(TOKEN_PROGRAM); } })));
});

test('tampered bytes, noncanonical base64 and another signature cannot prove native payment', { skip: !implemented }, () => {
  let fixture = receiptFixture();
  const bytes = Buffer.from(fixture.receipt.transaction[0], 'base64'); bytes[1] ^= 1;
  fixture.receipt.transaction[0] = bytes.toString('base64');
  assert.throws(() => verify(fixture));
  fixture = receiptFixture(); fixture.receipt.transaction[0] += '\n';
  assert.throws(() => verify(fixture));
  fixture = receiptFixture(); fixture.signature = '1'.repeat(88);
  assert.throws(() => verify(fixture));
});

test('unsafe or incomplete native arrays and unexplained lamport changes fail closed', { skip: !implemented }, () => {
  for (const mutate of [
    receipt => { receipt.meta.preBalances[0] = 9007199254740992; },
    receipt => { receipt.meta.postBalances[0] = '185000'; },
    receipt => { receipt.meta.preBalances.pop(); },
    receipt => { receipt.meta.postBalances.push(1); },
    receipt => { receipt.meta.postBalances[0] += 1; },
    receipt => { receipt.meta.postBalances[1] -= 1; },
    receipt => { receipt.meta.postBalances[2] += 1; },
    receipt => { receipt.meta.fee = 1.5; },
    receipt => { receipt.meta.fee = 9007199254740992; },
    receipt => { receipt.meta.innerInstructions = [{ index: 0, instructions: [{}] }]; },
    receipt => { receipt.meta.preTokenBalances = [{}]; },
  ]) { const fixture = receiptFixture(); mutate(fixture.receipt); assert.throws(() => verify(fixture)); }
});

test('native receipt cannot precede its intent slot or execute after its deadline', { skip: !implemented }, () => {
  for (const change of [{ slot: 99 }, { slot: 1.1 }, { blockTime: (NOW + 301000) / 1000 }, { blockTime: null }, { version: 0 }]) {
    const fixture = receiptFixture(); Object.assign(fixture.receipt, change); assert.throws(() => verify(fixture));
  }
  const fixture = receiptFixture(); fixture.receipt.blockTime = null;
  assert.equal(verify(fixture, { intent: { ...intent, expiresAt: undefined } }).failed, false);
});

test('finalized failure requires opt in and proves only fee loss with no payment', { skip: !implemented }, () => {
  const fixture = receiptFixture({ error: { InstructionError: [0, 'InsufficientFunds'] } });
  assert.throws(() => verify(fixture));
  assert.deepEqual(verify(fixture, { allowFailure: true, expectedFeeLamports: '5000' }), { lamports: '10000', feeLamports: '5000', slot: 120, failed: true });
  assert.throws(() => verify(fixture, { allowFailure: true, expectedFeeLamports: '4000' }));
  for (const mutate of [
    receipt => { receipt.meta.err = { invented: true }; },
    receipt => { receipt.meta.postBalances[0] -= 1; },
    receipt => { receipt.meta.postBalances[1] += 1; },
    receipt => { receipt.meta.err = { InstructionError: [2, 'InsufficientFunds'] }; },
  ]) { const changed = structuredClone(fixture); mutate(changed.receipt); assert.throws(() => verify(changed, { allowFailure: true })); }
});
