# Closed LIVE accounting kernel

Private implementation and fixture tests only. Nothing imports this module in the gateway or world server. It creates no key, signature, transaction submission, public route or activation flag. Existing TEST balances and the earlier withdrawal prototype are separate and are **never** copied here. The current TEST bridge is not a valid LIVE adapter.

## Interface

`createAccounting({path,config,rpc,resolveWallet,world,clock=Date.now})` returns a frozen facade. Use a new dedicated SQLite path. `config` requires `phase:'LIVE'`, `namespaceId`, `genesisHash`, conventional SPL `mint`, `decimals`, `treasuryWallet`, `treasuryTokenAccount` and a positive canonical decimal `atomsPerGameUnit`. This complete namespace and its conversion become immutable on creation. A foreign/TEST/prototype database, incomplete schema or changed configuration fails closed.

Amounts and character GUIDs are canonical decimal strings; account IDs are bounded positive integers. Never pass floating point money. Game units are capped at 2147483646; atoms and aggregate claims use raw u64. Every batch balances exactly, claims stay nonnegative, world claims are exact conversion multiples, and total claims equal recorded reserve assets.

Methods:

- `createDeposit({accountId,id,atoms,sourceTokenAccount})` creates a 15 minute account/wallet/config-bound intent. `resolveWallet(accountId)` must read a previously signature-bound account wallet. `rpc.call(method,params)` is a trusted read-only Solana adapter.
- `confirmDeposit({accountId,id,signature})` verifies finalized status, genesis, the actual Ed25519 signed legacy TransferChecked/memo receipt, exact source/mint/program/treasury/deltas, conventional mint/account bytes, and observed finalized treasury coverage before one immutable credit. It reuses the pure verifier, **not** the old settlement journal.
- `fundPool({id,accountId,poolId,atoms})` transfers existing vault claims into a system pool; it never creates backing.
- `prepareWorld({id,accountId,guid,kind,units,poolId?,eventId?,reason?})` reserves claims and commits an outbox entry before world mutation. Kinds: `grant` vault→world, `redeem` world→vault, `issue` funded pool→world, `sink` world→pool. `issue` requires a globally unique authoritative `eventId` and one of `quest`, `loot`, `vendor-sale`, `starting-money`. This is a trusted server API, never a client reward endpoint.
- `advanceWorld(accountId,id)` reconciles or applies once via the world adapter, validates a bound receipt, moves claims atomically, then acknowledges the durable accounting batch. Timeouts never refund. It retries only acknowledgement after local settlement. It releases the local character lock only after a matching world acknowledgement.
- `operation(accountId,id)`, `character(accountId,guid)`, `balance(accountId)`, `pool(poolId)`, `totals()`, `close()` inspect state. `balance` reports available vault and allocated world claims; reserved claims remain conserved but are unavailable. `AccountingStore` is an internal primitive and must not be exposed to request handlers.

## Mandatory world adapter contract

`authorizeCharacter(request)` returns `{phase:'LIVE',namespaceId,configHash,accountId,guid,moneyUnits,version}`. New characters must have zero money. Existing snapshots must exactly match backed local allocation and version. An authoritative ownership change, nonzero stock balance or unexplained save/version divergence fails closed.

`readReceipt(operation)` returns a durable bound receipt or null. Null permits idempotent `apply(operation)` under the world's own transaction/fence; it does not prove rejection. `apply` must compare the expected account, balance and version, and serialize all money/inventory/quest effects and older saves. It must durably preserve a fence until accounting acknowledgement. Identical operation retries must return the identical receipt. Concurrent callers must not cause a second effect.

The receipt fields are `phase,namespaceId,configHash,id,operationId,accountId,guid,kind,units,beforeUnits,afterUnits,beforeVersion,afterVersion,outcome,reason`. An applied receipt requires the exact computed result and version+1, with reason `applied`. Rejection requires unchanged money/version and a checked reason: `policy-rejection`, `stale-version`, `missing-character`, `owner-mismatch`, `overflow`, `insufficient-money`. Unknown/error/timeouts remain reserved. Receipt identity cannot be reused for another operation.

`ack({operation,receiptId,receiptHash,batchKey})` must durably/idempotently acknowledge the matching immutable receipt/accounting batch before releasing the world fence. It returns `{phase:'LIVE',namespaceId,configHash,operationId,receiptId,receiptHash,batchKey}`. A lost ack response is safe only if retry returns that same durable acknowledgement; the kernel's local lock remains until then. The world adapter must not be the current TEST bridge, whose fence lifetime is shorter.

All adapters run inside the trusted server boundary. No adapter accepts a browser-provided `verified` boolean or balance. Production proof providers require an independently operated/reviewed RPC trust policy; mocked RPC results are test evidence only.

## Remaining integration gates

This kernel does not connect stock `ModifyMoney`, quest/item/vendor/mail/AH/trade/start-money/GM/script paths, online/login/save fences, or a production worker. All positive game issuance must reserve a funded pool before the complete authoritative game event, and all transfers/escrows must conserve existing claims. The current stock world remains TEST and nonredeemable.

`withdrawal_reserved` is a defined journal bucket only: no withdrawal API/signing/broadcast exists here. Any future withdrawal must use this same journal, preserve reserve-before-sign and persist-before-send semantics, and reduce claims/assets together only after proof. Importing the old prototype ledger would duplicate claims and is forbidden.

Activation still requires actual world integration and queue/fault testing, final mint/conversion acceptance, funding/custody/fees, monitoring/reconciliation, access controls and launch review. A mint address alone cannot enable this system.

## Verification

From the repository root, install the existing realm dependencies, then run:

```text
npm ci --prefix deploy/realm
npx --yes node@24 --test deploy/realm/bridge/accounting/tests/*.test.mjs
```

Tests use real SQLite files and independent OS processes, published RFC signature vectors and injected RPC/world fixtures. They submit no network transactions. The existing realm-bridge workflow also runs this suite. See the closed LIVE accounting spec/plan under `docs/superpowers/` for the state contract. Independent review is required before integration.
