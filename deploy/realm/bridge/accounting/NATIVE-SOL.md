# Conserved native SOL policy: isolated devnet only

The user selected native SOL instead of a future custom token. Native SOL uses lamports with 9 decimals, no mint, token account, wrapping or token exchange. This extends the existing conserved kernel; it does not create a second ledger or expose custody over HTTP.

## Explicit immutable configuration

```js
const config = {
  phase: 'LIVE',                 // Existing backed-accounting proof domain, not mainnet.
  assetKind: 'native-sol',
  cluster: 'devnet',
  namespaceId: 'devnet-sol:isolated-example',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  decimals: 9,
  treasuryWallet,                // Explicit ordinary signing wallet; no key is stored here.
  atomsPerGameUnit,              // Positive exact lamport string; no implicit economic scale.
  reserveFloorLamports,          // Positive exact operator reserve, excluded from player backing.
  withdrawalFeePolicy: 'gross-includes-network-fee',
};
```

Use a fresh dedicated database. The namespace must start with `devnet-sol-`, `devnet-sol:` or `devnet-sol.`. The full genesis hash is pinned; mainnet, shortened chain identifiers, SPL fields and other fee policies are refused. The complete normalized configuration and hash are immutable. Existing SPL namespaces retain their earlier normalization/hash and cannot be reinterpreted as SOL. TEST/prototype databases remain refused. The public TEST journal is unchanged.

## Deposits and complete backing

`createDeposit({accountId,id,atoms})` resolves the previously signature-bound wallet on the server. Native calls reject `sourceTokenAccount`. A finalized ordinary empty System Program source account, treasury account and pinned network are required. The durable intent binds the account, wallet, exact amount, memo, namespace, created slot and deadline.

`confirmDeposit({accountId,id,signature})` checks finalized status and the complete actual signed legacy System Transfer + Memo transaction. The source is the sole signer and fee payer. Treasury credit equals the deposit; source debit equals deposit plus network fee; every other account balance is unchanged. Exact array lengths, canonical encodings, safe numeric RPC values, empty token effects and no CPI are required. Signature and intent replay remain atomic and idempotent. Observed treasury lamports must cover **all** recorded claims plus the independent reserve floor. A monotonic persisted chain-observation floor rejects stale snapshots after concurrent deposits or withdrawals.

## Withdrawals and fees

`reserveWithdrawal({accountId,id,atoms,destinationWallet})` requests a **gross** debit including the network fee. The destination must equal the server's verified linked wallet; token-account fields are refused. Existing account locks prevent overlapping world/event/withdrawal mutations. Only available vault claims can be reserved.

Before reserving any claim or account lock, the native path pins the exact blockhash and its actual finalized block origin, reads the native transaction's fee with `getFeeForMessage`, and rejects a fee consuming the entire gross request. It checks the fee for the exact net payment message too. `feeLamports`, `netLamports`, the blockhash origin and the fee policy commit atomically with the reservation and lock. A rejected tiny or unavailable-fee request leaves the account free to retry a valid amount. Preparation reuses this immutable plan across restart and concurrent fee quotes. The approved adapter signs and returns bytes only. The kernel checks the entire message and actual signature, then stores immutable signed bytes before any broadcast. Repeat sends reuse those bytes.

- Finalized success must prove the quoted fee, exact net recipient credit and gross treasury debit. The gross reservation and recorded reserve decrease together.
- Finalized failure still charges its proven quoted network fee. Only the net remainder returns to the vault; recorded reserve and claims both decrease by the fee.
- Complete archival expiry proof returns the full gross request because it proves no transaction executed.
- Timeout, missing receipt, mismatched fee, inconsistent balances, incomplete history and any ambiguous send retain the full reservation. No replacement payment is signed.

Observed reserve checks, native account validation, monotonic proof floors, exact receipt checks and terminal idempotency apply across restart. This fee policy must be presented before any future public approval; the current wallet has no active deposit or withdrawal action.

## Evidence and remaining work

The new tests use synthetic signed transactions and injected RPC responses. They check native signatures/deltas, gross/fee/net conservation on success and failure, restart/replay, ambiguous sends, expiry, immutable namespace, reserve floor and stale observations. Existing SPL/accounting tests remain required. These are **offline fixtures**, not actual on-chain devnet payment acceptance or a funded game launch. A read-only network hash check proves network identity only.

The public gateway imports neither this kernel nor a signer. It still reports TEST game balances and refuses deposits/withdrawals. Actual stock-gameplay transaction hooks, funded reward pools, the durable world adapter, signer custody, worker/reconciliation operations, chain acceptance, limits and recovery drills remain necessary. No token CA or liquidity pool is needed for SOL-only gameplay; funded and trustworthy money flows are still required.

References: [Solana transactions](https://solana.com/docs/core/transactions), [transaction receipts](https://solana.com/docs/rpc/http/gettransaction), [message fee RPC](https://solana.com/docs/rpc/http/getfeeformessage), [network clusters](https://solana.com/docs/references/clusters).
