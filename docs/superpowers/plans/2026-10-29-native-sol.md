# Native SOL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the realm's custom-token target with native SOL and implement devnet-native receipt/accounting support without activating public custody.

**Architecture:** Extend the conserved accounting kernel with an explicit native SOL asset policy. Keep the existing TEST game economy distinct and close legacy swap routes in the realm gateway.

**Tech Stack:** Node 24, SQLite, @solana/web3.js, existing esbuild browser assets.

**Spec:** docs/superpowers/specs/2026-10-29-native-sol-design.md

## Global Constraints

- No mainnet activation, signing credentials, transfers, legacy balance migration or invented game conversion.
- SOL amounts are exact lamports; native accounting is explicitly devnet-only and configuration is immutable.
- Preserve old SPL behavior and existing authentication/CSRF/ownership guarantees.
- Withdrawal gross debit includes its quoted network fee; failed transactions consume only their proven fee.

## Review Focus

- A stale token launch flag must never reopen realm market routes.
- Wrong-network RPC and rounded numeric lamports must not become balances or receipts.
- A failed native transaction still charges a fee and must preserve reserve conservation.
- Lost replies and restart must not sign replacement transactions or release ambiguous reservations.
- TEST allocations and existing character money must never become SOL claims.

### Task 1: Native SOL wire proof

**Files:** create deploy/realm/economy/settlement/native-sol.mjs and tests/native-sol.test.mjs.

- [ ] Write and run failing tests for exact native transfer construction, signature/message/lamport-delta proof, successful and failed fees, wrong destinations/amounts/memos, extra instructions, unsafe numbers and account ownership.
- [ ] Implement focused exported native transfer/account/receipt functions using existing signature primitives, without network mutation or wallet keys.
- [ ] Run protocol and existing settlement tests; independent reviewer checks the proof boundary.

### Task 2: Conserved devnet SOL accounting

**Files:** modify bridge/accounting/{amounts,deposit,withdrawals}.mjs; add tests/native-sol-accounting.test.mjs and fixtures as needed.

- [ ] Write and run failing tests for explicit devnet SOL config, immutable namespace, native finalized deposits, gross/fee/net withdrawal conservation, failed-fee accounting, retry/restart, fee-too-large rejection and treasury reserve floor.
- [ ] Extend configuration and existing adapters using Task 1's exact proof functions. Keep old SPL normalized configuration unchanged.
- [ ] Persist the fee policy in immutable prepared/signed withdrawal proofs; preserve ownership, stale-proof floors, reservation locks, receipt replay and archival absence guards.
- [ ] Run all accounting tests and independent review. Native changes remain unreachable from public HTTP.

### Task 3: SOL-only realm wallet and routes

**Files:** modify economy/{api,wallet,wallet-ui}.mjs, web/proxy.mjs as needed, tests and module documentation.

- [ ] Write failing API/gateway tests for SOL config, genesis-checked native reads, stale mint/launch flags and TEST isolation.
- [ ] Publish SOL denomination/network fields, remove launch-token messaging and swap mounts, and refuse legacy realm market paths without outbound calls.
- [ ] Run economy/gateway tests and browser asset build. Verify actual UI without connecting or signing a wallet.
- [ ] Review and commit exact-owned files, push the existing feature branch, and update the existing draft PR. Deploy only after local/integration checks pass; keep the pinned WASM/runtime and core unchanged.

### Task 4: Release evidence

- [ ] Record what passed and the distinction between synthetic devnet fixtures, real chain acceptance and funded gameplay.
- [ ] If deployed, verify current readiness, authenticated SOL-only wallet view, character snapshot, and closed real settlement routes. Report any unresolved blocker precisely.
