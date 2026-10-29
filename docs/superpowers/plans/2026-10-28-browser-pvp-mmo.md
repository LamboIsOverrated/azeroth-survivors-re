# Browser PvP MMO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deploy a playable original-Classic browser PvP realm with persistent characters and an integrated configurable Solana wallet/test economy.

**Architecture:** Restore the existing MMO client and import the compatible pinned realm account service. Deploy a public web/account service, private combined auth/world core, and private MariaDB, each with its own volume. A separate Node economy gateway uses the authenticated realm identity, keeps exact test-ledger balances, and leaves real-token settlement disabled until launch inputs exist.

**Tech Stack:** Rust/Bevy/WASM, Axum realm service, CMaNGOS Classic, Classic DB, MariaDB, Node 24, Solana web3, Railway, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-28-browser-pvp-realm-design.md`, approved by user instruction to proceed and fill implementation blanks.

## Global Constraints

- Original Vanilla 1.12.1/build 5875, standard faction open-world PvP, individual non-GM accounts.
- Preserve the current Survivors preview and its branch deployment.
- No game assets, passwords, signing keys, or account credentials in Git or public build artifacts.
- Real deposits/withdrawals and gameplay payouts remain disabled without the final mint and a funded, reconciled reserve.
- TEST realm starts separately from future live characters/items/currency; show no-carryover policy.
- Exact integer amounts; no browser-authoritative money/reward claims; no arbitrary network relay.
- User authorized implementation/deployment and delegated remaining choices. Proceed with parallel specialist implementation and reviews; no additional plan handoff approval is needed.

## Review Focus

1. Cross-origin and cross-account requests cannot control another account or borrow its wallet/character identity.
2. Restart, duplicate input, and concurrent ledger updates must not create extra test funds or discard persistence.
3. Database/data initialization is restartable and never reinitializes an existing character database.
4. A healthy HTTP port cannot stand in for actual world readiness, browser login, or PvP compatibility.
5. WASM source changes must ship a fresh MMO artifact; the old Survivors release cannot silently be used.

## Ownership and shared interfaces

- Task 1 owns `crates/wenilla-realm/**`, `crates/wenilla/**`, new `crates/wenilla-survivors/**` if needed, Cargo manifests/lockfile, and MMO-specific web bootstrap.
- Task 2 owns `deploy/realm/core/**`, core/database Dockerfiles, core initialization/config tests and provenance.
- Task 3 owns `deploy/realm/economy/**`, the MMO wallet UI/bundle and durable account ledger tests. Do not change existing `deploy/server.mjs` behavior.
- Coordinator owns `deploy/realm/web/**`, combined public image/runtime/proxy, CI workflows, Railway setup and integration, documentation and final checks.
- Realm identity endpoint: authenticated `GET /api/identity` returns `{id: integer, username: string, isAdmin: boolean}`; unauthenticated 401, no-store, no game password. Node forwards cookies to loopback realm and uses only this server-derived id.
- Node public gateway listens on `PORT` (Railway 8080), realm HTTP on loopback 8090. Proxy normal HTTP/WS to realm; economy routes under `/api/economy/`, wallet UI asset `/realm-wallet.bundle.js`. Preserve original Host and permitted Origin; strip untrusted forwarding headers.
- Realm mounts state `/state`, client data `/state/client/Data`, browser output `/app/www`; core host `realm-core.railway.internal` with ports 3724/8085/7878; MariaDB `realm-db.railway.internal:3306`.

### Task 1: Restore MMO launcher and authenticated realm service

**Files:** import pinned original `crates/wenilla-realm/**` with attribution; modify `crates/wenilla/src/lib.rs`, Cargo.lock as needed; add `web/realm.html`/build selection if needed.

**Interfaces:** produce realm executable using existing environment names, `/api/identity`, authenticated `/play`, `/api/play`, and `/ws/{3724,8085}`. The optional wallet module is loaded from `/realm-wallet.bundle.js` on the real play page.

- [ ] Import compatible source at `d68dcc539460e8fc5169105c790443489d91ca76` after verifying availability and source provenance; inspect account, CSRF, credential, and relay code before adapting.
- [ ] Add failing tests: unauthenticated identity 401; authenticated identity no credential leakage; bad/missing/cross-site WS origin rejected; only 3724/8085 allowed; wrong game-account handshake refused; file-backed admin/preset controls unavailable in remote-config mode.
- [ ] Implement ordinary MMO launcher and separate Survivors launch path/artifact, exact-origin/identity protections, remote-config mode, TEST banner/reset policy, optional wallet module. Preserve upstream attribution.
- [ ] Run realm integration tests, host tests, wasm check, formatting. Report missing local toolchain separately and use Linux CI/container verification when needed.
- [ ] Commit only owned paths after tests; never push/deploy independently.

### Task 2: Package restartable Classic PvP core and database

**Files:** create `deploy/realm/core/Dockerfile`, runtime/init/config/extraction scripts, tests, pinned `upstreams.env`/provenance and database setup as needed.

**Interfaces:** consume `DB_HOST`, `DB_PORT`, `DB_ROOT_PASSWORD`, `DB_MANGOS_PASSWORD`, `DB_REALMWEB_PASSWORD`, `REALM_DOMAIN`, `/realm-data` volume, compatible client input. Produce private realmd/world/SOAP listeners, PvP `GameType=1` plus realmlist icon1, generated configuration, and readiness/status on `PORT` without exposing admin operations publicly.

- [ ] Inspect and pin the companion core image by immutable digest with exact upstream source revisions; use its existing compiled core/extractors for the first runtime if compatible. Retain a reproducible source build recipe and licenses.
- [ ] Write failing tests for unsafe generated values, missing required map dirs, existing database preservation, reentrant initialization, bots disabled, PvP config and graceful shutdown supervision.
- [ ] Implement idempotent DB bootstrap and core start with private database grants, game account admin separate from ordinary players, fixed ports, and extractors writing only owned data volume. Run long map extraction as resumable runtime initialization, not image build.
- [ ] Run shell/config tests and container smoke checks. Never report world readiness until actual listeners and schema/data checks pass.
- [ ] Commit only owned paths; coordinate deployment/schema setup with parent, no independent Railway resource mutation.

### Task 3: Build authenticated configurable crypto/test economy module

**Files:** create `deploy/realm/economy/{ledger,api,wallet}.mjs`, wallet UI/CSS as needed, and Node tests.

**Interfaces:** export `createEconomy({identity, dbPath, env, fetchImpl})` HTTP handler for `/api/economy/*`; identity is async `(req) -> {id,username,isAdmin}|null`. Export status/config safe for UI. SQLite ledger persists under `/state/economy.sqlite` using Node24 built-in sqlite. Wallet bundle optional on real play page; build with existing esbuild and Solana web3 dependencies.

- [ ] Write failing tests for authentication/account isolation, exact decimal parsing, duplicate ledger operation IDs, concurrent spends, restart persistence, signed wallet challenge binding/expiry/replay, unavailable/missing mainnet configuration, and no reward endpoint accepting client kills.
- [ ] Implement append-only account TEST journal, balance/history, one-time bounded test allocation only by admin/server configuration (never repeated on reconnect), game-character balance read path only through trusted server data or explicitly report unavailable rather than pretend ledger is in-game money.
- [ ] Implement wallet connect and signed single-use account binding plus configured mint/SOL balance display; reuse existing fixed-pair launch-gated swap logic if it can preserve realm authentication. Label all test funds nonredeemable; real settlement routes return disabled unless a fully implemented verified path exists.
- [ ] Build wallet asset and test all routes using identity injection and real signature checks. Do not create keys, mint, send tokens, or seed treasury.
- [ ] Commit owned paths, report bridge/game-wallet integration limits explicitly; no independent deploy.

### Task 4: Integrate public web runtime and build pipelines

**Files:** coordinator creates `deploy/realm/web/Dockerfile`, runtime/proxy, Node package/build scripts, `.github/workflows/realm.yml`, Railway service configs, and operational documentation.

**Interfaces:** consumes Task1 realm executable+MMO wasm, Task3 handler/bundle, environment and `/state` data volume; produces public HTTPS app with account login, actual `/play`, economy panel, and no raw private core endpoints.

- [ ] Add failing proxy tests for exact Origin, authenticated WS forwarding, absolute/protocol-relative target rejection, original Host behavior, no cross-user identity fallback, static private caching, helper failures and readiness states.
- [ ] Build source-pinned Linux client/realm artifacts in GitHub Actions and publish versioned release/container with source/license references. For repeat builds use build caches; preserve original Survivors deployment artifact.
- [ ] Implement combined runtime, helper supervision, account identity bridge, no-store wallet APIs, authenticated game data caching, and private initialization input transfer.
- [ ] Run complete Node/realm targeted checks and a fresh independent review before public service deployment.

### Task 5: Deploy private test realm and verify gameplay

**Files:** coordinator updates deployment docs and `outputs/` private account instructions, never commits secrets.

- [ ] Create separate Railway staging environment and three services/volumes with private DNS, resource caps, and generated secrets supplied without printing them. Preserve existing production preview.
- [ ] Initialize DB, stage compatible client data, run map extraction, and record readiness honestly; long generation is meaningful ongoing work, not a reason to claim completion early.
- [ ] Deploy reviewed web/core images. Provision separate admin and ordinary test accounts. Test actual browser create-character/login/world entry, persistence over restart, and interactive two-player PvP under repository probe rules.
- [ ] Verify wallet panel in actual world, signed binding/account isolation, TEST labels and unavailable mainnet functions. Verify representative core economy flows without claiming mainnet redemption.
- [ ] Test database/web-state backup restore into separate scratch data, then provide live URL, private instructions, GitHub PR, tested features, and unresolved limits.

### Task 6: Complete available integration and review

- [ ] Independently review full branch for security/economy correctness, inspect original requirements against observed behavior, fix material findings and rerun appropriate checks.
- [ ] Implement any remaining testable token bridge pieces only where they can be proven safely without CA/signer/funding. Keep all incomplete mainnet paths closed and document exactly which launch inputs and work remain.
- [ ] Push branch, create/attach reviewable PR against the user's fork, and report the actual deployment state without presenting a TEST realm as an already launched crypto economy.
