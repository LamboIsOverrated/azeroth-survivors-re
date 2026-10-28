# Closed atomic event stage

Implementation plan and state contract, based on the exact de8f729 core money audit in the sibling `audit/README.md` and `event-map.json`. Existing authorization permits filling implementation choices. This adds only private accounting code and fixtures; it does not authorize or implement any core caller, public route, transaction signer or LIVE activation.

## Design

A server-owned immutable event quote contains: coordinator account, unique operation/event IDs, typed family, gameplay plan SHA256, participant accounts/characters, escrow actions, and individually identified positive-unit legs. An owner is a character with an exact account/GUID, a funded system pool, or a named durable escrow. Conversion is the existing immutable atomsPerGameUnit. No participant netting can fund a gross outgoing leg; all sources must already own the full quoted outflow. Transfers never debit issuance pools. Every source reserve and every target fence is one SQLite transaction.

The trusted world snapshot binds the request hash, all participant money/version/gameplay-state hashes and existing escrow metadata/money/version, including proof of absence for newly created escrows. Account, character, escrow, save/login and gameplay-item/quest/loot/AH state must be fenced together. The complete receipt covers every actor, every escrow, exact legs and complete gameplay digest. Receipt-driven financial settlement and all recorded participant/escrow state updates are one transaction; no partial owner receipt is accepted. Ambiguity retains all claims and locks. The accounting acknowledgement is durable before the world releases any fence.

Persistent escrow states: open; returned/expired (claims retained under the fixed recovery beneficiary); settled/deleted (zero claims). Return/expiry never creates a refund and cannot erase backing. Deletion must explicitly relocate the full remaining claim into a recovery escrow owned by the predetermined retained account. A terminal escrow identity cannot be recreated. Character deletion similarly needs an explicit full relocation and retires the character identity. No timer releases a pending operation; expiry is a separate authoritative event after prior locks clear.

Exact per-leg application authority enumerates each character/escrow debit and credit, including separate nested quest money sites. A one-use synchronous ticket consumes one exact owner/side/amount before invoking the mutation. Any reuse, different amount, omitted ticket, Promise, or reentrant money authority (even for another event) aborts the private simulation. This is a reusable fail-closed boundary and fixture, not a C++ field-writer guard: all audited core callers and generic field writers still require integration and checked rollback.

## Schema/state compatibility

Schema 2 adds escrow state, immutable retired-character identities, and a schema marker; resource locks permit multiple keys per operation. Schema 1 can upgrade atomically only after all old operations are complete. Immutable chain/configuration/conversion and journal postings are unchanged. An incomplete or foreign schema fails closed. New single-character operations share account/character resource locks with batches, so neither path can bypass a pending batch.

## Tasks and verification

- [x] Write failing multi-owner atomic transfer and receipt-isolation tests; implement event preflight, source holds, complete receipt and ack.
- [x] Cover funded group/quest, escrow create/return/expire/claim/delete and character-retirement conservation.
- [x] Write failing narrow exact-leg/reentrant authority tests; implement one-use guard without a broad permit.
- [x] Verify process concurrency, competing accepts, all-or-none overdraft and durable lost-reply/restart recovery. Run previous accounting tests unchanged.
- [x] Commit only owned accounting files and request fresh independent review.
- [x] Complete independent review of this closed accounting stage before integration.

Verification on 2026-10-28: 42 accounting tests plus 9 existing TEST bridge tests pass under Node24, including independent-process reservation races, same-event double acceptance and abrupt process exit after reserve. Exact per-leg guards are exercised through a staged adapter that publishes no actor state when a nested/altered mutation fails; explicit async handlers are rejected before their bodies run. Auction tests prove deposit/bid conservation and one explicit fee, without reward-pool issuance. These are local closed fixtures, not running-core acceptance.

Independent review found two material closed-module defects before integration: recovery checked only its current beneficiary, allowing a substituted owner/retained pair to redirect a later deletion; an invalid expired A ticket poisoned only A, allowing B to continue if it caught that error. The red regressions reproduced both. The fixes require the complete predetermined recovery identity, including automated auction payout/refund and return/expiry paths, and poison the current active context on every invalid ticket attempt. No sink may run after that context is poisoned. Fresh independent review of commit `aba712b` found both fixes complete and no new actionable finding. Independent and coordinator Node24 runs each passed all 52 accounting plus 9 TEST bridge tests with no skips. No financial integration or activation follows from these tests.

## Gates still open

Full C++ preflight and checked complete gameplay transaction before effects; account/login/map/save/version/field-writer fences; all stock quest/vendor/trade/mail/AH/expiry/delete/import/GM/script paths; real CharacterDatabase FIFO/rollback/fault drills with actual gameplay; durable worker and monitoring; production RPC trust/custody/funding/mint acceptance. Software kernel tests do not satisfy those gates. The stock MMO currency remains TEST/nonredeemable, and CA alone enables nothing.
