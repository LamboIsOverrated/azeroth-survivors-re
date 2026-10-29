# Closed LIVE accounting stage

Authorized as an implementation step toward the browser MMO currency requirement. This stage is a private accounting kernel with injected, trusted proof/world adapters. It does not activate a live bridge, public routes, signing, funding, or stock-world redemption.

## One namespace and exact conversion

Each new dedicated SQLite file owns one immutable LIVE namespace: namespace ID, chain genesis, conventional SPL mint/program/decimals, treasury authority/token account, and a strictly positive integer atomsPerGameUnit. Every amount is a canonical decimal string or internal BigInt. Raw atoms use u64 bounds; character units use 0–2147483646. Conversion never rounds; remainders remain in the vault/pool. Reopening with a changed namespace or conversion fails. Existing TEST/prototype ledgers are refused, never imported.

## Conserved journal

Every immutable batch has postings summing to zero. `external_reserve` is the negative counterbalance of verified reserve assets. Nonnegative claim buckets are `vault_available`, `vault_reserved`, `withdrawal_reserved`, `world_allocated`, `world_escrow`, `pool_available`, and `pool_reserved`. Owner keys bind accounts, characters, pools and operations. Total positive claims equal negative external reserve, never exceed u64, and every character/escrow allocation is exactly divisible by the immutable conversion.

Only a finalized, account-bound deposit proof from the trusted Solana verifier can increase external reserve and claims together. It must verify the real signed receipt, chain/mint/program/treasury/source wallet, exact atoms, intent domain/deadline, finalized status and observed backing. No method accepts a browser balance or `verified:true` field. Receipt identities are unique and tied to the immutable request. No credit path reads TEST balances or the earlier prototype settlement journal.

## World saga contract

A trusted character snapshot must identify the same LIVE namespace/configuration, account/character, exact money and durable balance version. A new character can enter the kernel only with zero money; nonzero untracked world money is not a token claim. Ownership cannot silently change. The snapshot must match existing backed character claims/version; mismatches refuse admission.

Intent kinds are vault→world grant, world→vault redemption, funded issuance, and a game payment into a funded system pool. Intent creation atomically reserves the relevant source bucket and persists the outbox operation. One unresolved operation owns a character at a time. Account-scoped idempotency keys cannot change their payload; authoritative issuance event IDs also cannot be reused for another account/character.

The world adapter must provide a durable world-owner fence spanning asynchronous saves, actual money/item/quest processing and the receipt. The applied receipt must bind namespace/config, account/character, operation ID/type, exact units, before/after money and balance version. Rejected receipts prove no change. TEST/cross-account/cross-namespace/malformed/conflicting receipts fail closed. Missing/ambiguous/timeout results keep reservations; elapsed time never creates a refund.

After a valid world receipt, one SQLite transaction moves the reserved claims to the destination (or restores them on rejection), records the unique receipt, and persists awaiting-ack state. The world fence must remain until a matching idempotent accounting acknowledgement proves that batch durable. Lost ack replies retry ack only, never reapply/recredit. Character admission remains locked until ack. This is stricter than the current TEST prototype, which cannot serve as the LIVE adapter.

## Funded issuance

Pools receive claims only by moving existing verified vault backing. Issuance reserves pool atoms before a world grant; no pool means no reward. Typed reasons include existing server-authoritative quest, loot, vendor-sale and starting-money events; no client kill reward exists. Game payments/sinks return existing character claims to a pool. Transfers must conserve claims through a separate authoritative transfer/escrow integration, never masquerade as fresh issuance. The kernel does not wire stock ModifyMoney/SetMoney callers or invent their completion semantics.

The journal defines a withdrawal reservation bucket, but this kernel exposes no withdrawal operation or signer/broadcaster. A future withdrawal integration must reserve existing vault claims in this same journal and reduce reserve assets and reserved claims together only after finalization; ambiguous outcomes must remain held. Integration with the older withdrawal prototype must use this one journal rather than crediting two independent ledgers.

## Required evidence and limits

Tests use real file-backed SQLite, published signature fixtures and injected network/world responses. They cover exact conversion/u64 limits, immutable configuration, namespace isolation, append-only conservation, unfunded issuance rejection, duplicate/cross-account receipts, restart at each saga boundary, lost acknowledgements, and concurrent processes competing for the same backing. Fresh independent review precedes any integration.

Still required for activation: final mint/conversion acceptance, actual funded reserve/custody/fee arrangement, a complete world-owned money-event/issuance audit and implementation, online/login/save/version fencing, real restored-world queue/fault acceptance, durable worker and reserve monitoring, access controls, and an explicit launch decision. Stock loot remains TEST and nonredeemable. A CA alone does not satisfy these requirements.
