# Browser realm infrastructure

`.railway/railway.ts` describes only the three MMORPG services and their volumes in `pvp-staging`. Its named `browser-mmo` partial and environment guard keep the existing Survivors preview and disposable recovery services outside this file's ownership. Do not convert it to whole-project ownership while those services live in the same project.

The account/browser service uses the `deploy/realm` build context and `Dockerfile`; the private world service uses the `deploy/realm/core` context and its `Dockerfile`. Core releases use `deploy/realm-core`; browser gateway changes use `feat/browser-pvp-mmo`. There is one replica of each service because their attached state and the world simulation are not shared between replicas.

Service resource ceilings are 6 GB / 4 CPUs for the core, 4 GB / 2 CPUs for web, and 2 GB / 1 CPU for MariaDB. These are ceilings, not measured player capacity or an uptime guarantee. The initial world configuration admits 40 players; wider capacity requires a real load test.

Install the pinned SDK with `npm ci` at the repository root. Link the existing project/environment, then use `npm run infra:plan` to inspect differences. Confirm the selected environment is `pvp-staging` and that the plan contains no deletes or replacements. This file is a reviewable definition; inspect a fresh plan before any apply. The live services were initially configured through the provider API and their source/health must be checked against the latest plan before migration. Existing legacy deployment configuration may require an explicit provider migration first.

Secrets use `preserve()` and are never placed in Git. The public runtime URL and SHA256 also preserve their already configured release values; publishing a new Rust client/account binary requires updating those two values together deliberately. Changing the gateway branch alone does not replace the pinned native binary. Web image builds verify the digest before extracting the code bundle. Game MPQs are private volume inputs and are never included in a release or source commit.

`REALM_TRANSPORT_PROFILE` preserves the deployed client's explicit server compatibility setting. The verified `b092b35` Rust/WASM pair supports `cmangos-classic-4d230bb1`; set it together with that pair's release URL and SHA256. The older `a3ff560` pair does not support this setting. Preserve the previous pair and environment for rollback, and verify actual browser entry after rollout.

`/healthz` proves the wrapper is running; `/readyz` requires the account database, game files, SQL, SOAP and world listeners. During `REALM_MAINTENANCE=1`, wrappers remain available for recovery but gameplay and account writers stop. Maintenance state is an operator-controlled environment setting and is intentionally not reset by this file. See [the recovery runbook](../docs/REALM-OPERATIONS.md) before capture or restore.

The realm targets native SOL; no custom-token CA or token exchange is required. Pair the preserved `ECONOMY_SOLANA_CLUSTER` with `ECONOMY_SOLANA_RPC_URL` for read-only wallet balances. The default cluster is devnet; every read checks its full genesis hash. Existing character money remains TEST, and real transfers stay closed pending a reconciled treasury, signer operations, funded game issuance and reviewed world escrow. An infrastructure apply cannot activate settlement.

