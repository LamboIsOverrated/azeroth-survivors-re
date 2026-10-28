# Closed token settlement engine

This is an **internal, independently testable engine**, not a live token bridge. No web route imports it. Existing `/api/economy/deposit`, `/withdraw` and `/swap` remain disabled. There is no environment switch that activates this engine. Supplying a CA cannot enable game redemption. It has no keys, funding, network adapter or background broadcaster, and tests send no network transactions.

## Interface and explicit configuration

```js
import {SettlementEngine} from './engine.mjs';
const engine = await SettlementEngine.open({
  dbPath: '/state/live-settlement.sqlite',
  config: {genesisHash, mint, decimals, treasuryWallet, treasuryTokenAccount},
  rpc,                    // {sourceId, async call(method, params)} -> raw JSON-RPC result
  archiveRpc,             // optional independent archival source, same interface
  signer,                 // optional {async signTransaction(unsignedBytes)} -> signed Uint8Array
  resolveWallet,          // async accountId -> server-verified linked wallet address
});
```

No defaults exist for chain, mint, precision or treasury. Opening the engine reads the pinned genesis hash and finalized raw mint/treasury account data. The immutable SQLite configuration includes chain, mint, program, decimals, treasury authority and treasury token account; reopening with different values fails. Conventional SPL Token only: the owner must be `Tokenkeg…`, with exact 82-byte Mint / 165-byte Account layouts, initialized state, no Token-2022/extensions/native-wrapped SOL/delegate/separate close authority. This first scope additionally requires the mint's mint/freeze authorities disabled and an ordinary single-signature treasury wallet. Decimals are explicitly pinned in the supported 0–18 range.

RPC adapters are trusted custody dependencies. They must use fixed configured URLs, TLS, timeouts, bounded responses, consistent JSON parsing and verified source identity. No browser may choose a URL, RPC method, account ID, signing key or wallet binding. `sourceId` is an operator identity for independent providers, not cryptographic proof of independence. Mainnet requires independently established provider completeness and failure policies. The signer must **only sign and return bytes**, never broadcast; this engine verifies the actual Ed25519 signature and byte-identical message. A hardware/remote signer adapter must enforce the same policy independently.

## Finalized deposits

`createDepositIntent({accountId, atoms, sourceTokenAccount})` resolves the account's server-verified wallet and verifies its current finalized source token account. It persists a five-minute random account-bound intent, fixed amount, source account, wallet, created slot and unique memo. It returns `id`, `memo`, amount and transfer fields. The future frontend/adapter must construct exactly one legacy `TransferChecked` followed by that Memo instruction, signed solely by the wallet as fee payer. Existing token accounts are required. Sponsored fees, extra instructions, plain Transfer, multisig, CPI, lookup tables and versioned transactions are deliberately unsupported and fail closed.

`confirmDeposit({accountId,intentId,signature})` requires a successful finalized full-history status and raw finalized transaction. It verifies the actual signed wire message, signature, source wallet, mint, token program, treasury destination, exact raw u64 amount, decimals, memo, slot and intent execution deadline. It verifies pre/post source and treasury token metadata and exact balance deltas; UI token floats are never used. Settlement may be reconciled after the deadline if the actual transaction executed within its intent window. It rejects unknown/failed/pending/malformed/stale receipts. Crediting also requires current observed treasury backing for all existing liabilities plus this deposit.

Only then does one immediate SQLite transaction consume the receipt and append the LIVE credit. Both signatures and intent receipts are unique. Duplicate confirmations return the original result, including after restart; a different signature cannot reuse a consumed intent. A wallet sending multiple transfers with one consumed memo requires manual custody reconciliation: the engine does not guess or credit unbound deposits.

## Durable withdrawals

`reserveWithdrawal({accountId,idempotencyKey,atoms,destinationTokenAccount})` verifies the bound destination wallet/account and treasury solvency, then atomically moves available atoms into reserved atoms. A stable account-scoped idempotency key cannot change its amount or destination. Separate engine connections serialize reservations with `BEGIN IMMEDIATE`; no negative balance is permitted.

`prepareWithdrawal({accountId,withdrawalId})` requires that durable reservation, rechecks the destination and solvency, reads a finalized recent blockhash and constructs the exact TransferChecked + withdrawal memo. It passes unsigned bytes to a transaction-only signer and verifies the returned message/signature. It durably saves the signed bytes, first signature, blockhash and last valid height **before any send RPC**. Competing preparers may compute signatures but only one immutable transaction wins; every later broadcast uses that stored transaction, never a newly signed replacement. No signing callback may itself send a transaction.

`broadcastWithdrawal({accountId,withdrawalId})` rechecks observed solvency, persists `pending` before calling `sendTransaction`, and submits only those stored bytes. An acknowledged signature does not settle funds. A timeout, rejected preflight, different returned signature or process crash leaves the reservation pending. Repeating the method rebroadcasts byte-identical data; it never creates another payment. A treasury shortfall freezes new signing/broadcast without releasing a customer claim. Reconcile known transactions first when their finalized payouts have reduced observed reserves.

`reconcileWithdrawal({accountId,withdrawalId})` uses the **stored signature**, full-history lookup and a sufficiently recent context. Finalized success consumes reserved atoms once; finalized failure returns them once. Processed/confirmed success or error, missing status, timeout and malformed responses keep funds reserved. Terminal states are idempotent.

Automatic expiry release is more conservative than a timeout: it requires both the primary and a separately identified archival RPC to show finalized height above the stored last valid height, finalized blockhash invalidity, retained block coverage from the signing slot, and full-history status plus finalized raw transaction absence. Missing archive, pruned history, conflicting observations, incomplete responses and errors retain the claim. These observations rely on honest complete archival RPC sources; a null response alone never constitutes an expiry proof. A production custody review must validate their archival coverage. No replacement transaction is signed for an ambiguous payment.

`balance(accountId)` returns `{namespace:'LIVE_ATOMS',available,reserved}` as exact decimal strings. `history(accountId)` returns the most recent 100 append-only journal entries. `getWithdrawal({accountId,withdrawalId})` enforces account ownership. `pendingWithdrawals()` is an internal worker recovery listing of up to 100 unsettled rows; it is not a public account API. An eventual worker needs durable pagination/fair scheduling at scale. `close()` closes SQLite after incoming work stops.

## Namespace, durability and remaining launch gates

The engine's `live_*` tables never read or convert the TEST journal, even if accidentally placed in the same database. Use the dedicated live database path above operationally. TEST allocations cannot become LIVE claims. Every raw amount is a canonical decimal string backed by BigInt in the range 1…u64::MAX; journal deltas are TEXT so SQLite's signed 64-bit integer limit cannot truncate SPL u64 atoms. Available/reserved journal entries and transition events are append-only. Configuration and signed withdrawal bytes are immutable. WAL plus synchronous FULL and immediate transactions provide local atomic durability; back up consistently including WAL, and prove restore behavior in deployment. Offline fixtures verify restart and competing connections; machine/storage failure recovery still needs operational drills.

This engine accounts for **account vault claims only**. It does not implement CMaNGOS money conversion, game escrow, online saves, vendor/trade/mail/auction atomicity, or a durable game-server queue. Before live activation the system still needs the final CA and mint acceptance, immutable atoms-per-game-unit conversion and cap, reserve/treasury funding, approved signer/custody design, SOL fee funding, continuous reserve reconciliation, withdrawal limits/fees, authenticated request/CSRF/rate limits and user confirmation, a durable settlement worker, chain-identity and archival-provider monitoring, game-server escrow with crash-safe idempotent operations, abuse controls, full independent security review, backup/restore drills, and an explicit launch decision. No claim of a production crypto MMORPG follows from these isolated tests.

## Offline checks

Run Node 24:

```text
node --test deploy/realm/economy/settlement/tests/*.test.mjs
```

Fixtures import published RFC 8032 signature-vector seeds to sign synthetic transactions; no wallet is generated, funded or used onchain. RPC and signer fixtures exercise the real parser, signature verifier and file-backed SQLite lifecycle. They never make external network calls. Tests cover exact u64 values above signed SQLite range, source/mint/program/amount/memo proof, replay/account isolation, immutable configuration, reserve-before-sign and persist-before-send, restart recovery, competing engines, ambiguous broadcasts, terminal idempotency, archival expiry guards, signer tampering and reserve freezes.

Primary references: [SPL instruction definitions](https://github.com/solana-program/token/blob/main/interface/src/instruction.rs), [SPL state layouts](https://github.com/solana-program/token/blob/main/interface/src/state.rs), [getTransaction](https://solana.com/docs/rpc/http/gettransaction), [full-history signature statuses](https://solana.com/docs/rpc/http/getsignaturestatuses), [blockhash validity](https://solana.com/docs/rpc/http/isblockhashvalid), [confirmation and expiration](https://solana.com/developers/guides/advanced/confirmation).
