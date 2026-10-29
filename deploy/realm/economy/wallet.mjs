import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { genesisFor } from './solana-network.mjs';

export function canonicalAddress(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) throw new Error('Invalid wallet');
  const key = new PublicKey(value);
  if (key.toBase58() !== value) throw new Error('Non-canonical Solana address');
  return value;
}

export function canonicalWallet(value) {
  canonicalAddress(value);
  if (!PublicKey.isOnCurve(new PublicKey(value).toBytes())) throw new Error('Wallet must be an Ed25519 signing address');
  return value;
}

export function issueChallenge(ledger, id, wallet, origin, now) {
  canonicalWallet(wallet);
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = now + 300_000;
  const message = `Realm TEST wallet link\nOrigin: ${origin}\nAccount: ${id}\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature links your wallet only. It does not authorize transfers. TEST balances have no cash value and do not carry over to launch.`;
  ledger.db.prepare(`INSERT INTO wallet_challenges(account_id,nonce,wallet,origin,message,expires_at,consumed) VALUES(?,?,?,?,?,?,0)
    ON CONFLICT(account_id) DO UPDATE SET nonce=excluded.nonce,wallet=excluded.wallet,origin=excluded.origin,message=excluded.message,expires_at=excluded.expires_at,consumed=0`).run(id,nonce,wallet,origin,message,expiresAt);
  return {challengeId: nonce, message, expiresAt};
}

export function verifyChallenge(ledger, id, challengeId, signature, origin, now) {
  if (typeof challengeId !== 'string' || !/^[a-f0-9]{64}$/.test(challengeId) || typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid wallet proof');
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) throw new Error('Invalid wallet proof');
  return ledger.transaction(() => {
    const row = ledger.db.prepare('SELECT * FROM wallet_challenges WHERE account_id=? AND nonce=?').get(id,challengeId);
    if (!row || row.consumed || row.origin !== origin || row.expires_at <= now) throw new Error('Wallet challenge expired or unavailable');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(row.wallet).toBuffer()]);
    if (!verify(null, Buffer.from(row.message, 'utf8'), createPublicKey({key: spki, format: 'der', type: 'spki'}), bytes)) throw new Error('Invalid wallet signature');
    const owner = ledger.db.prepare('SELECT account_id FROM wallet_bindings WHERE wallet=?').get(row.wallet);
    if (owner && owner.account_id !== id) { const error = new Error('Wallet already linked to another account'); error.status = 409; throw error; }
    ledger.db.prepare('INSERT INTO wallet_bindings(account_id,wallet,linked_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET wallet=excluded.wallet,linked_at=excluded.linked_at').run(id,row.wallet,now);
    ledger.db.prepare('UPDATE wallet_challenges SET consumed=1 WHERE account_id=? AND nonce=?').run(id,challengeId);
    return row.wallet;
  });
}

export async function chainBalances({wallet, cluster = 'devnet', rpc, fetchImpl}) {
  const genesis = genesisFor(cluster);
  if (!wallet || !rpc) return {available: false, cluster, reason: !wallet ? 'Link a wallet to view its SOL balance.' : 'SOL balance display is not configured.'};
  canonicalWallet(wallet);
  async function call(method, params) {
    const response = await fetchImpl(rpc, {method: 'POST', redirect: 'error', headers: {'content-type': 'application/json'}, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}), signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error('Chain balance unavailable');
    const json = await response.json();
    if (json.jsonrpc !== '2.0' || json.id !== 1 || json.error || !Object.hasOwn(json,'result')) throw new Error('Chain balance unavailable');
    return json.result;
  }
  if(await call('getGenesisHash',[]) !== genesis)throw new Error('Solana network mismatch');
  const sol = await call('getBalance', [wallet, {commitment: 'finalized'}]);
  // Solana JSON emits lamports as a number; refuse values that cannot be represented exactly.
  if (!Number.isSafeInteger(sol?.context?.slot) || sol.context.slot < 0 || !Number.isSafeInteger(sol.value) || sol.value < 0) throw new Error('Chain balance unavailable at this precision');
  return {available: true, cluster, genesisVerified: true, commitment: 'finalized', solLamports: String(sol.value), displayOnly: true};
}
