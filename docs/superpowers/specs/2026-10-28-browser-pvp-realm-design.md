# Browser Classic PvP realm and Solana currency

Status: approved by the user on 2026-10-28: proceed and fill implementation blanks. Deployment verification is tracked separately; this document alone does not establish a running realm.

## Intent and confirmed requirements

The user wants the original WoW Classic experience in a browser, expanded from the supplied Survivors fork: a persistent shared world with open-world PvP and crypto as its spendable currency. Server setup, GitHub delivery, and Railway hosting are included. The user has no existing server and will supply the Solana token mint address last. The earlier Survivors deployment is a working preview, not completion of this request.

The compatible target is original Vanilla 1.12.1, build 5875. This is not Blizzard's modern Classic client or an official Blizzard service. The first delivery is an invite-only test realm, not a claim of complete compatibility across every dungeon, quest, class, and browser.

## Approaches

1. Restore this fork's original MMO launcher and connect it to CMaNGOS Classic, reusing the wenilla-realm account and browser relay foundation. Recommended: this preserves the existing renderer and game interfaces and delegates combat, world rules, quests, persistence, and PvP to a real server. It requires a fresh client build, a separate world/database deployment, and integration testing.
2. Write a new MMO server around Survivors. Rejected for this goal: the local arena simulation does not supply Classic's world, quest, inventory, combat, and persistence systems. Recreating them would be a separate game project.
3. Stream a native game executable through a remote desktop. Rejected for this goal: this changes the product into a video-streaming service and adds per-session infrastructure instead of using the existing browser client.

The user selected open-world PvP following the proposed Classic realm direction. The concrete technical choices below are the implementer's proposals; they have not been independently approved by the user.

## Player experience

- Open an HTTPS URL on a desktop WebGPU-capable browser, sign into an individual game account, create a character, and enter the shared world. No native game executable installation.
- Retain the original races, classes, character progression, gear, quests, NPCs, and world systems supported by the pinned client/server. Resolve incompatibilities as measured bugs rather than claim the inherited code is fully verified.
- Use standard Alliance/Horde PvP realm rules, including faction territories, contested zones, sanctuary rules, and normal death/resurrection behavior. This is a proposed default, not free-for-all PvP everywhere.
- Persist characters and possessions across logout, browser refresh, and server restart. Classic restrictions on factions per account remain unless deliberately changed later.
- Keep the current Survivors preview available while the separate MMO realm is built and tested.

No staking, coin loss on death, automatic cash bounty per kill, bots, or accelerated leveling is part of the initial realm. The user requested PvP, not these additional money mechanics.

## First playable milestone

The first implementation target is a private, deployed multiplayer realm with individual accounts, browser login, character creation, world entry, character persistence, and normal faction PvP. It uses unmistakably labeled TEST currency. It does not need the real contract address, a treasury, or a player wallet to play.

Acceptance requires the browser talking to the actual game server, not a locally simulated world or a successful HTTP health check. Test two distinct ordinary-player accounts, world visibility, persistence after a clean restart, and faction hostility. Conduct the live PvP acceptance interactively under repository probe rules; do not run unattended combat probes. Record precisely what was observed and which broader game systems remain untested.

## Runtime and source architecture

### Browser and accounts

Restore `crates/wenilla/src/lib.rs` from `benilla_app::run_survivors` to the ordinary MMO entry path. Keep Survivors available through a separate launcher/artifact rather than silently replacing the existing live preview. Refresh the MMO page title, bootstrap settings, and account flow. Turn off URL credential fallback in hosted pages. Retain optional wallet UI without requiring it for test gameplay.

Bring the compatible `crates/wenilla-realm` account/session and authenticated play/relay source from a pinned original wenilla revision into this fork, including required templates, assets, migrations, tests, and attribution. The existing checkout does not contain that crate. Build it against this fork's host/formats/protocol crates; it does not depend on Bevy. Verify dependency compatibility before implementation. Do not use an upstream prebuilt Survivors WASM archive for the MMO. Publish a fresh checksum-pinned client artifact with matching source revision and licenses.

One web identity owns its provisioned game account. Provision through the realm service's game-account path with dedicated SQL/SOAP permissions. Never reuse the shared preview code as the game identity. Registration stays invite-only for the first milestone. Admin endpoints require a separate admin role. Preserve secure cookie sessions, origin checks, request limits, and separate non-GM player accounts.

### Fixed Railway topology

Deploy three services in a separate staging environment, leaving the existing preview deployment untouched:

1. Public web service: HTTPS browser assets, authenticated account/play routes, authenticated WebSocket relay, and the wallet gateway. It owns one persistent `/state` volume for client data and web account state. Railway terminates TLS; no Caddy is required inside the service. Internal helper processes bind to loopback.
2. Private core service: CMaNGOS `realmd` on 3724, `mangosd` on 8085, and restricted SOAP on 7878, with extractors available for initialization. It owns one `/realm-data` volume containing generated configuration and extracted `dbc`, `maps`, `vmaps`, and optionally `mmaps`. Supervise both core processes and shut down gracefully so characters save.
3. Private MariaDB service: a persistent `/var/lib/mysql` volume containing authentication, character, and world databases. Separate migration/admin credentials from runtime identities.

No public database, SOAP, auth, or world TCP endpoint. The browser reaches only the HTTPS web service. The relay's destination map is fixed to the private core's auth/world ports; client URL parameters must never choose a network destination. Require an authenticated session and exact configured Origin before WebSocket upgrade. Upstream's existing Fetch-Site check is insufficient for this requirement. Its raw relay also does not bind the protocol account to the web identity: restrict the auth/world handshake to the provisioned game account, or implement an equivalently explicit account binding with the authoritative game server. Test cross-account attempts and session possession independently. Wallet/character ownership must come from the authoritative game account, never a supplied browser identifier.

The existing Node gateway blocks `/ws/*`; add relay support deliberately for the MMO service only. Do not remove that protection from the old Survivors preview. The low-level host relay is not itself an authentication layer.

Railway volumes cannot be shared by these services. Client MPQs and server extracts have independent volumes and initialization. The companion project's Docker Compose configuration assumes a shared configuration directory; adapt its file-backed admin settings before use. Generate core configuration from environment variables in the core service; disable shared-file editing/presets until they have a working remote control path. This is not a direct `docker compose up` deployment on Railway.

Use pinned CMaNGOS and Classic DB revisions that are known to work together, versioned database migrations, and reproducible images with source/license references. Default to bots off and a capped private test population. Verify actual memory/storage use before expanding capacity. Do not scale replicas of a single world process.

### Data and initialization

Keep all game install content out of Git, release artifacts, and container images. Source-code licenses do not grant rights to game assets. Keep access restricted to authorized preview participants and document the operator-provided client-data requirement.

Existing input: the private Railway Survivors preview already has approximately 5.4 GB of client MPQs in its persistent volume, initialized by the earlier deployment. Use a read-only copy as the candidate extraction input, rather than requiring another upload before work can start. Verify its exact patch chain, required files, and extractor compatibility before calling it complete. Transfer directly between controlled runtime storage or through a private temporary staging path; never publish the data as a GitHub artifact. If validation finds missing/incompatible files, report the specific missing input; do not invent a successful extraction. This establishes availability of a candidate dataset, not a new claim of asset licensing.

Extract required server data from the compatible client data once into the core's volume. Validate extractor exit codes, expected files, and version before world startup. Require `dbc`, `maps`, `vmaps`, and `mmaps`; the companion's current startup guard requires movement maps despite older optional wording. Generate them through a separate resumable initialization job before the serving process starts, not during normal image builds or every deployment. Full extraction may take hours. Never download an unverified third-party server datapack as a shortcut.

Provide separate readiness states for accounts, data initialization, login server, database, and world server. A listening web port does not mean the realm is playable. Initialization must be idempotent and must not reset existing characters on redeploy. Configure CMaNGOS `GameType = 1`, realm-list `icon = 1`, and build 5875: the list icon alone does not enable PvP. Test players have GM level 0.

The companion disables its anti-cheat module for browser compatibility. This is not evidence that valuable reward farming is protected. Keep real-money reward activation separate from basic multiplayer compatibility and validate movement/combat abuse before launch.

## Currency design

### One currency rail

Use CMaNGOS's authoritative integer money rail for every ordinary economic action: vendors, repairs, trainers, flights, quests, loot, trade, mail/COD, and auction escrow/settlement. Display denominations as fractions of one configured token; gold/silver/copper must not become separate unrelated cryptocurrencies. XP, health, and honor remain gameplay statistics rather than spendable substitute coins.

Do not perform an onchain transaction for every in-game payment. An account/bridge ledger represents claims on deposited or explicitly funded tokens, while normal game operations remain server-controlled and fast. This introduces reserve/custody requirements for a future live bridge; the existing wallet-signing swap panel alone does not implement that bridge.

The original money cap is 2,147,483,646 game units. Never put arbitrary nine-decimal SPL atoms directly into that field. Define an immutable positive integer `atomsPerGameUnit` after inspecting the real mint's decimals and selecting an acceptable game holding cap. The account vault can hold amounts beyond the character cap. Non-divisible token atoms remain in the vault; never round money away or silently change conversion after balances exist. TEST units do not promise a launch-token conversion.

### Test phase

Use TEST currency for the initial playable realm, including ordinary server-generated quest/loot/vendor proceeds. Clearly mark it as nonredeemable. No mainnet deposits or withdrawals, mint creation, treasury funding, private-key generation, or token swaps are part of the first milestone. A devnet bridge test can follow once the game is stable; creating even a test mint should be an explicit implementation choice, not an assumed launch token.

Proposed launch isolation: test and live realms use separate databases, account-economy namespaces, and journals. Live launch starts with fresh characters, inventories, mail, auctions, and currency; preserve the TEST realm separately if desired. Usernames may be re-provisioned after ownership verification, but test progression/items cannot silently enter the live redeemable economy. Any future carryover requires a separately approved migration and liability audit. This reset policy is the implementer's proposed default and must be visible in the test UI before players invest time.

### Later token bridge

- Bind a wallet to the authenticated account through a single-use, expiring, domain-bound signed challenge. A typed public address is insufficient proof of ownership.
- Verify actual mint, token program, decimals, recipient, amount, and finalized chain transfers server-side. Initially support a conventional SPL token; unsupported Token-2022 transfer features must fail closed.
- Maintain a durable immutable journal and unique deposit identifiers including signature and instruction position. Replaying a chain transaction never credits twice.
- Transfer money between the account vault and a character through a world-owned idempotent command queue. Do not externally update an online character's money field: game saves can overwrite it. A future logout-only variant would require a login fence as well as logout verification.
- Reserve withdrawals durably before sending. Persist transaction identity, reconcile ambiguous submission failures, and never refund/retry merely because an RPC request timed out. Keep signing credentials out of Git and the browser.
- Reconcile all redeemable liabilities, including characters, vaults, mail, auctions, and pending transfers, against custody assets. Stop settlement when reconciliation fails.
- Audit every creation/destruction path, not only `ModifyMoney`. Quest rewards, max-level XP conversion, loot, resale, scripts, administrative commands, and bot activity can create money without a player deposit. A treasury reward reserve must fund any such redeemable rewards. Administrative grants in the test realm must not turn into live claims.

The user's answer about gameplay reward funding is still outstanding. It does not block the TEST realm. Before real money activates, agree on whether rewards are redeemable and fund or disable every affected source. The user has not authorized taking coins from PvP losers or paying kill bounties.

### Contract address last

Build the game against a token configuration interface, leaving the mainnet mint unset. Later validate the supplied mint onchain; choose and lock the conversion; configure a funded treasury, signer, fees, and limits; complete restart/concurrency/replay and reserve tests; then explicitly activate deposits/withdrawals. SOL/token swaps remain independently launch-gated and need an available liquidity route. A CA alone cannot supply liquidity or back gameplay rewards.

## Delivery stages and checks

1. Restore and build the MMO client and account/session/relay boundary, preserving a separate Survivors artifact. Validate WASM/native builds, account isolation, origin/session/port guards, and deployment configuration without game data.
2. Deploy the three private-test services, initialize schemas and extracted data, configure a PvP realm, create individual test accounts, and verify browser login/world entry. Record first-run readiness and restart behavior.
3. Verify the actual multiplayer/persistence/PvP milestone with ordinary players and TEST currency. Test representative vendor, trade, mail/COD, and auction operations and note unsupported client paths.
4. Implement and test the durable token ledger/bridge on a non-mainnet environment, including exact amounts, duplicate requests, online saves, crashes, ambiguous chain submissions, and reserve reconciliation.
5. Accept the final CA and launch-economy decisions; complete live configuration and activation checks separately. Do not convert TEST balances automatically or describe the first milestone as a full production launch.

Apply repository gates appropriate to changed code. Use a fresh source-pinned engine artifact for any client changes. Provide concrete GitHub changes, deployed URLs, private account instructions, and a tested-feature list at each delivery. Back up web state, configuration, and all databases; perform a restore test before opening persistent play beyond the initial preview. Roll back application releases without rolling schemas backward blindly or losing character progress.

## Builder decisions and later user decisions

The builder may select compatible source revisions, dependency layout, migration tooling, exact service environment names, capped test resources, and health/backup mechanisms, documenting the choices. Those choices must satisfy the fixed architecture and acceptance requirements above.

Later user decisions: token mint and symbol, final game-unit conversion, reward redeemability/funding, treasury/signing arrangement, and launch withdrawal policy. None are prerequisites for the browser TEST realm. Free-for-all PvP, death-related coin transfers, bots, and public launch require a further deliberate scope decision.

## Evidence and primary references

- Local launcher `crates/wenilla/src/lib.rs` invokes `run_survivors`; `crates/benilla-app/src/lib.rs` retains the ordinary MMO entry path and disables networking specifically for Survivors.
- Local `crates/benilla-protocol/src/transport/web.rs`, `crates/wenilla-host/src/ws.rs`, and `web/README.md` define the binary WebSocket-to-TCP scheme; `deploy/server.mjs` currently rejects the relay paths.
- [wenilla-realm foundation](https://github.com/Arnesen/wenilla-realm): account/relay/deployment integration. Its VM/Compose packaging requires adaptation for Railway.
- [CMaNGOS Classic](https://github.com/cmangos/mangos-classic) and [Classic DB](https://github.com/cmangos/classic-db): game server and world data sources.
- [CMaNGOS Player money fields](https://github.com/cmangos/mangos-classic/blob/master/src/game/Entities/Player.h), [money implementation](https://github.com/cmangos/mangos-classic/blob/master/src/game/Entities/Player.cpp), and [character schema](https://github.com/cmangos/mangos-classic/blob/master/sql/base/characters.sql): integer precision, limits, and persistence.
- [Solana signature status RPC](https://solana.com/docs/rpc/http/getsignaturestatuses): settlement must distinguish ambiguous submission from confirmed failure.

These sources establish an implementation path, not proof that this particular fork already runs a multiplayer realm successfully.
