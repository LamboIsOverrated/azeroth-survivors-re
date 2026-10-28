# Closed LIVE Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task by task. User authorization to fill implementation choices already exists; no approval handoff is needed.

**Goal:** Implement conserved, durable vault/world and funded issuance accounting without enabling live financial operations.

**Architecture:** A new dedicated Node24 SQLite journal owns an immutable namespace/conversion. Proof-only Solana reads fund it; durable world sagas and funded pool operations move existing claims, with authoritative receipts and a final acknowledgement barrier.

**Tech Stack:** Node24 built-in SQLite, BigInt, existing Solana signature/receipt verifier, injected world adapter, Node tests.

**Spec:** `docs/superpowers/specs/2026-10-28-closed-live-accounting.md`.

## Global Constraints

- New private files under `deploy/realm/bridge/accounting/**`; leave existing TEST/prototype stores and public routes untouched.
- No live enable flag, signing/key generation, funding, chain submission or deployment.
- Positive immutable integer atomsPerGameUnit; exact u64 atom strings, Classic unit cap2147483646, no rounding.
- All postings conserved, all nonreserve buckets nonnegative, no TEST receipt or balance import.
- Missing/ambiguous evidence never releases a reservation; world acknowledgement follows durable accounting.

## Review Focus

- Two ledgers must not both credit the same eventual deposit or world claim.
- A valid receipt from another account, namespace or TEST world must not settle an operation.
- Restart after world commit or accounting commit must not issue/release claims twice.
- Pool rewards must reserve verified backing before a world grant, with no arbitrary credit method.
- Stale snapshots and uncategorized stock money must not become backed claims.

### Task1: Exact namespace and conserved store

Files: `accounting/amounts.mjs`, `accounting/store.mjs`, `accounting/tests/store.test.mjs`.

- [x] Write/run failing exactness, immutable config, foreign-ledger refusal and conservation tests.
- [x] Implement dedicated schema, append-only batches/postings and invariants.
- [x] Verify file restart and competing transactions.

### Task2: Verified deposits and world saga

Files: `accounting/deposit.mjs`, `accounting/kernel.mjs`, `accounting/tests/kernel.test.mjs`.

- [x] Write/run failing real signed deposit and receipt/account/phase isolation tests.
- [x] Implement proof-only Solana adapter, zero-baseline character admission and reserve/apply/reject/ack states.
- [x] Verify lost replies and restart around each durable boundary; never release on timeout.

### Task3: Funded issuance pools and review

Files: same kernel/store plus `accounting/tests/process-worker.mjs`, README and scoped CI test discovery.

- [x] Write/run failing unfunded pool, event replay, exact conversion and multi-process spend tests.
- [x] Implement pool funding, reserved issuance and conserved game payments.
- [x] Run the relevant suites and commit only owned files.
- [ ] Obtain fresh independent review before integration.

Verification: 20 closed accounting tests plus 9 existing TEST bridge tests pass under Node24. Tests include exact signed fixture proofs, invalid proof gating, dedicated-database/schema refusal, append-only double entry, restart/lost acknowledgement recovery, funded rewards and two OS processes competing for backing. No public routes or runtime imports were added. Independent review and actual LIVE world/custody integrations remain pending.
