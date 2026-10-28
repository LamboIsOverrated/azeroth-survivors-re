# Funded vendor sale implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one actual full-stack vendor sale atomically consumes a funded pool claim, moves its item/buyback state and credits the correct character, with durable recovery through every failure boundary.

**Architecture:** Replace the pinned handler's effect section with a coordinator-owned staged transaction. Shared raw-writer/login/save fences precede the handler slice; existing closed accounting supplies the complete gross reservation and receipt/ack settlement. Every production-source change requires coordinator-owned isolated patch/build integration.

**Tech stack:** Pinned CMaNGOS C++, existing CharacterDatabase FIFO writer, disposable MariaDB/InnoDB, Node24 closed accounting; no new public transport or chain adapter.

**Spec:** [DESIGN.md](DESIGN.md); existing [atomic accounting contract](../accounting/ATOMIC-EVENTS.md).

## Global constraints

- Source revision exactly `de8f72993b9e1faa1bf92dd5505f3daec5cea3ce`; baseline audit 2,208 files/226 sites/61 APIs must match before patching.
- Existing TEST paths/WorldBridge header, tested private binary, Dockerfiles and movement probe are outside this plan's current editing ownership. Coordinate patch/build ownership with root before executing source changes.
- No LIVE flag, deployment, generated key, signer, funding, live SQL or imported stock balance. All execution tests use disposable state.
- Journal/web account and realm/session account remain explicit separate identities; game cap `2147483646`, checked u64 arithmetic, fixed namespace/config/conversion.
- Only initially supported ordinary full-stack backpack sale; every unsupported effect rejects before mutation. Unsupported financial families are entry-rejected for enrolled fixture actors while TEST stays unchanged.
- No queued success, dirty-flag reset, item destruction or live callback before the checked complete transaction. Unknown outcomes retain leases; timers never refund/unlock.
- Stop older worker processes before any schema extension; incompatible pending states fail closed. No migration clears arbitrary locks.

## Review focus

1. Queued stale saves before and after the event, with unchanged money but stale inventory epoch, must not overwrite committed item/quest/buyback state (Tasks 1/3).
2. Socket loss, login query already in flight and restart after COMMIT must recover a single durable image without a stale logout save (Tasks 1/3/5).
3. Cross-language hash/canonicalization, unequal web/realm IDs, reused/expired tickets caught inside another event must fail before any sink (Tasks 1/2).
4. Lost prepare response, insufficient pool after world quote and late reservation racing quote cancellation must leave either one hold or one durable abort tombstone (Task 2).
5. Buyback eviction, item location uniqueness, malformed dirty queues, allocation/publication failures and callback-triggering quests must preserve both item and money or quarantine exact committed recovery (Tasks 3/4/5).

## Proposed owned file map

All new carries/tests/scripts start under `deploy/realm/bridge/live-core/`, independently of TEST:

- `include/Contract.h`, `src/Contract.cpp`: bounded typed envelopes, canonical plan/request bytes and exact source/domain/bindings.
- `include/LegAuthority.h`, `src/LegAuthority.cpp`: move-only exact tickets, one-use field permits and poison context.
- `include/Coordinator.h`, `src/Coordinator.cpp`: IDs-only continuation/state machine, memory lease/lifecycle ownership, transport-independent trusted port.
- `include/Snapshot.h`, `src/Snapshot.cpp`: immutable images, financial version vs gameplay/save epochs, before/after digest and allocation-free publication.
- `include/CheckedEventOperation.h`, `src/CheckedEventOperation.cpp`: checked existing-writer SQL transaction, recovery/receipt/ack.
- `include/VendorSale.h`, `src/VendorSale.cpp`: pure quote/policy/staging and checked handler continuation.
- `sql/characters-v1.sql`: proposed disposable schema, constraints and explicit version/engine checks.
- `tests/contract_test.cpp`, `tests/authority_test.cpp`, `tests/coordinator_test.cpp`, `tests/vendor_sale_test.cpp`, `tests/database_fault_test.cpp`: meaningful behavior tests, actual core types in source integration tests.
- `tests/integration/`: disposable actual-core/MariaDB fault/restart fixtures and Node24 adapter integration; published RFC8032 fixture keys only where existing test dependencies require them.
- `tools/check-source.py`, `tools/run-unit-tests.ps1`, `tools/run-integration.sh`: read-only baseline/carry verification, reproducible tests (created with their owning implementation task).
- `patches/funded-world.patch`: complete checked carry against the pin; includes the required source helper/handler/save/login/field changes. No installer/build hook is added to current runtime until independent source review and separate authorization.

The test runners are implemented with their owning task; these are exact future command contracts, not existing passing commands:

```text
pwsh -NoProfile -File deploy/realm/bridge/live-core/tools/run-unit-tests.ps1 -CoreSource <isolated-pinned-core> -Suite all
bash deploy/realm/bridge/live-core/tools/run-integration.sh --source <isolated-pinned-core> --disposable-root /tmp/realm-live-core-tests --fault-matrix
python deploy/realm/bridge/audit/check_mutations.py --source <unmodified-pinned-core> --json
node --test deploy/realm/bridge/accounting/tests/*.test.mjs deploy/realm/bridge/tests/*.test.mjs
npm --prefix deploy/realm test
```

The unit runner configures/builds real pinned-core test targets and exits nonzero on any test/build failure; the integration runner creates only its explicit disposable database/service workspace and refuses existing realm connection settings. Each verification step below uses these commands, restricted to its named suite when targeted. Expected GREEN is exit 0 with no skipped fault case. Tests/runners do not exist in this design-only commit.

### Task 1: Real ownership, snapshot and exact mutation boundary

**Files:** Contract/LegAuthority/Coordinator/Snapshot files above; contract/authority/coordinator tests; future carry touches `Player.h/.cpp`, `Object.h/.cpp`, `CharacterHandler.cpp`, `WorldSession.cpp`, `World.cpp` and handler dispatch.

**Interfaces:** `Expected<WorldQuote,Reject> Coordinator::QuoteVendorSale(SaleIntent const&)`; `Expected<StageImage,Reject> StageVendorSale(WorldQuote const&, PreparedEvent const&)`; move-only `LegTicket::Apply(ExactMutation const&, StagedMoneyWriter&) -> Expected<void,Reject>`; `AcquireResources(sorted keys, operationId) -> Expected<LeaseSet,Busy>`. IDs use explicit WebAccountId/RealmAccountId wrappers. Coordinator continuations own immutable images/IDs, never raw actor pointers.

- [ ] Write failing C++ tests: web1/realm42 ownership; foreign session generation; two resource acquisitions all-or-none; exact one-use tickets; COINAGE-1 uint64 overlap; all primitive aliases/raw load; caught expired A ticket poisons current B; omitted/wrong/async/nested RewardQuest leg prevents every later sink.
- [ ] Run the new C++ tests against pinned core types using the task's test runner; record failure on absent checked boundaries, not a text-match assertion. Use Node golden fixture canonical bytes/hashes from `amounts.mjs` and ensure C++ agrees without deriving expected bytes from C++ itself.
- [ ] Implement typed contracts, detached images and barrier-driven leases; separate financial version from gameplay/save epoch. Add pre-load and pre-publish login checks, deferred logout/save ownership and entry rejection for unsupported enrolled-actor handlers. Preserve exact TEST behavior.
- [ ] Run tests plus actual core build; source gate must cover every raw store and all 55 event sites, with a reviewed post-patch classification for implemented/entry-rejected/hydration/helper paths. An unclassified path blocks the slice.
- [ ] Commit only the reviewed complete boundary carry and tests after coordinator agreement on source ownership; no installation/deployment.

### Task 2: Durable quote/reservation handshake without orphan release

**Files:** Coordinator/Contract and coordinator tests; `tests/integration/accounting-handshake.test.mjs`. **Separately coordinated accounting changes:** private prepared attestation and abort-unreserved tombstone, not owned by the present docs task.

**Interfaces:** `PreparedReservation{operationId,requestHash,planDigest,namespaceId,configHash}` returned only after existing `prepareEvent` reservation commits; `AbortUnreservedQuote(quoteId,operationId,requestHash) -> DurableAbort` serialized with prepare and tombstoning that identity. Trusted transport port delivers immutable prepared/abort proof to C++.

- [ ] Write RED Node/C++ integration tests: world quote then insufficient pool; worker exits before reserve; reserve commits but reply lost; cancellation races reserve; replay another request/namespace/mapping/quote; no state permits both abort and reserve.
- [ ] Run targeted tests and observe the current missing durable handshake/abort behavior.
- [ ] Add private durable handshake without changing existing request fields; bind quote through planDigest and exact persisted bytes. AuthorizeEvent must return its existing quote snapshot under lease. Never release a quote based on an ordinary missing-operation read. Unsupported/missing cancellation leaves a recoverable hold.
- [ ] Run original accounting/bridge/realm suites unchanged and new handshake tests; verify namespace, holds and foreign/TEST proof rejection through a real adapter, not only a JS world double.
- [ ] Commit only explicitly coordinated paths and request independent review before core apply integration.

### Task 3: Checked CharacterDatabase transaction and complete persistence

**Files:** CheckedEventOperation/Snapshot, schema and database fault tests; carry modifies all enrolled-character save/lifecycle writers and underlying checked database API. Extract nonmutating item/inventory/quest SQL image builders instead of calling stock save helpers speculatively.

**Interfaces:** `EnqueueCheckedEvent(PreparedEvent, StageImage, Completion)` on existing FIFO; `ReadReceipt(OperationIdentity) -> Applied|Rejected|CheckedAbsent|Unknown`; `Acknowledge(AckTuple) -> DurableAck|Unknown`. Completion is asynchronous, shared-owned and returns to the world barrier. SQL methods expose actual affected-row/readback results on the pinned connection.

- [ ] RED: fail Begin/every statement/Commit/rollback; disconnect before/after server COMMIT; no reconnect; false empty result vs nullptr; stale save enqueued before/after; corrupt update queue; item/quest dirty flags survive failure; non-InnoDB table/foreign schema; buyback victim and item have exactly one location.
- [ ] Run disposable MariaDB tests and record failure where stock transaction APIs falsely report completion or drop failure.
- [ ] Implement atomically persisted baseline snapshot/quote/resources; complete effect+version+item+inventory+quest+buyback+receipt transaction; immutable event identities/receipts; checked locking recovery. Ordinary saves CAS-check financial version and save epoch, preserve money, and update dirty state only after durability. Ambiguous outcomes leave lease rows and quarantine.
- [ ] Verify complete byte-identical receipt through restart and three process exits (before transaction, after COMMIT before reply, after ack before reply); inspect actual disposable SQL rows and recovered core image. Existing TEST database tests must still pass.
- [ ] Commit reviewed complete writer/schema/save carry and fault tests. Do not apply schema to any existing realm.

### Task 4: Actual full-stack sale handler and staged publication

**Files:** VendorSale, vendor_sale tests, carry handler at `ItemHandler.cpp:475–591` and pure extracted buyback choice/quest-check routines. No wrapping the existing effectful tail with a late money check.

**Interfaces:** `QuoteVendorSale` validates stock eligibility plus the slice policy; `StageVendorSale` computes immutable full after image/packets and exact `vendor-payouts -> character` leg; `PublishCommittedImage(OperationIdentity) -> Published|Quarantined` performs no allocation, callbacks or SQL. Success packets flush only after receipt settlement/ack and consistent publication.

- [ ] RED actual handler tests: no pool/cap overflow leaves original item/quest/buyback byte-identical; `SellPrice*count` overflow; count0 full sale; explicit full count; partial/charged/equipped/container/timed/script/cast/quest-effect cases fail before effects; every buyback slot occupied evicts exactly chosen victim; disconnect cannot roll back an applied sale.
- [ ] Run against real pinned Player/Item handler fixture; a mock money sink alone is insufficient. Seed independent literal expected item GUID/price/money rows and compare complete outcomes.
- [ ] Implement checked early continuation, one exact credit ticket, immutable before/after image serialization and complete SQL operation. Revalidate vendor/session/map/prototype/item/epochs at apply; mismatch produces only a checked durable rejection. Remove precommit stock packet/quest/update-queue effects for this path.
- [ ] Verify pool decreases by exact conversion, world allocation increases equally, character money and item/buyback state agree after reload, and duplicate operation yields no second item/money change. TEST fixture sale follows stock behavior.
- [ ] Commit complete sale carry and tests for independent source/runtime review. Do not expose broader handlers.

### Task 5: Crash matrix, actual adapter round trip and source/build handoff

**Files:** integration tests, source/carry checker and integration runner. Coordinator owns source application/build changes outside this directory.

- [ ] RED end-to-end tests use closed accounting plus actual patched handler/core and disposable MariaDB: quote -> reserve -> apply -> immutable receipt -> accounting settlement -> ack -> publication/unlock, with process kill/lost response at each boundary. Include loaded online actor, loading actor, in-flight logout, second session, competing sale/trade request, two unaffected accounts and all state races in Review Focus.
- [ ] Run test matrix before final wiring and record actual unsupported boundaries. Do not count source compilation or fake adapter success as passing the round trip.
- [ ] Implement remaining private adapter wiring inside the isolated fixture, bounded recovery listing/backpressure, durable pending visibility and deterministic startup sweep; publication failures reconstruct from committed image without refunding.
- [ ] Run source baseline audit then reviewed carry verification; full C++ build/unit/MariaDB integration; original Node24 accounting/bridge and realm package tests. Reconfirm tested TEST WorldBridge/movement artifact bytes are unchanged. Review every SQL/field/callback writer rather than auto-refreshing trusted manifests.
- [ ] Commit owned verified artifacts, obtain independent security/correctness review and hand exact patch/source/image/test identities to root. Remaining general gameplay families and production release gates stay explicit; no push/deployment/funding from this plan.

## Plan self-review and remaining scope

Every contract dependency maps to one of Tasks 1–5. The deliberate initial exclusions (partial/charged/timed/scripted sale and quest transitions) are behaviorally rejected before effects, not unimplemented branches that continue stock execution. Supporting those later needs a new complete staged plan and tests. Actual worker IPC/custody/production operational policy and every other financial family remain separate acceptance work; no checkbox above claims completion today. Root must coordinate the accounting handshake ownership and source/build integration before implementation begins.
