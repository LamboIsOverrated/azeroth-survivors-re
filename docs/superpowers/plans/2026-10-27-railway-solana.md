# Railway and Solana Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the user's GitHub fork and a protected Railway preview with a launch-gated SOL/game-token exchange.

**Architecture:** A Node gateway protects the existing Rust asset host and exposes constrained Solana balance and Jupiter order endpoints. A browser wallet panel signs transactions locally. A multi-stage Docker build produces the WASM client and native host; a persistent volume holds the data.

**Tech Stack:** Rust/Bevy/WASM, Node 24, Solana web3.js 1.98.4, Jupiter Swap V2, Docker, Railway.

**Spec:** ../specs/2026-10-27-railway-solana-design.md

## Global Constraints

- No copyrighted game data, credentials, private keys, or generated bundles in Git.
- No reward payouts authorized by local combat results.
- Swaps default off until explicit token launch configuration.
- Keep the game's network relay inaccessible through the public gateway.

## Review Focus

- Missing/incorrect preview credentials cannot expose game data.
- Mint/launch configuration errors cannot silently enable swaps.
- Amount precision must survive values above Number.MAX_SAFE_INTEGER.
- A signed transaction cannot replace an issued order's transaction message.
- Failed or expired orders must not appear successful or permit unrelated transactions.

### Task 1: Protected gateway and launch-gated exchange

**Files:** `deploy/server.mjs`, `deploy/economy.mjs`, `deploy/tests/gateway.test.mjs`, `deploy/package.json`.

- [ ] Write gateway integration tests for authentication, hidden secrets, launch prerequisites, strict pair/amount validation, order binding, message substitution, expiry, replay, and upstream failures.
- [ ] Run `node --test deploy/tests/gateway.test.mjs` and observe missing-feature failures.
- [ ] Implement `createGateway(options): http.Server`, `readConfig(env)`, `parseUnits(text, decimals): string`, and `formatUnits(raw, decimals): string`.
- [ ] Run `npm test` from `deploy/`; commit gateway, tests, and lockfile.

### Task 2: Wallet panel and production container

**Files:** `deploy/public/*`, `deploy/runtime.mjs`, `Dockerfile`, `.dockerignore`, `railway.json`, `scripts/web-build.sh`, `web/index.html`, `docs/RAILWAY.md`.

- [ ] Implement wallet connect, chain balances, quote review, explicit sign-and-execute, and clear prelaunch/data-loading states.
- [ ] Mount a wallet button on the existing game page and copy its assets in `scripts/web-build.sh`.
- [ ] Add a private runtime that starts the existing asset host only when data is available; keep gateway health available during initialization.
- [ ] Build browser assets and run gateway plus existing browser tests.
- [ ] Commit and open a pull request in the user's fork.

### Task 3: Railway deployment and verification

- [ ] Attach a persistent data volume, create private access credentials, and set Solana configuration with swaps disabled.
- [ ] Connect Railway to the reviewed GitHub branch and deploy the Docker image.
- [ ] Check build logs, live authentication, disabled swaps, game WASM, and game-data readiness separately.
- [ ] Report repository, deployment URL, access details, and exact launch prerequisites without claiming untested swaps or rewards are live.
