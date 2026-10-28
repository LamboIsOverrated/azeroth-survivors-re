# Browser realm acceptance record

Status recorded on 2026-10-28. This is a running **TEST realm**, not a production launch or a guarantee of defect-free operation. TEST characters, items and currency do not carry into the future redeemable economy.

## Deployed browser realm

[Open the TEST realm](https://realm-web-pvp-staging.up.railway.app/). The original Survivors preview remains a separate deployment. Accounts are managed through the realm administration page; private operator credentials are kept outside Git.

The deployed web gateway is at `a365d9a` and uses the source-built `a3ff560` MMO artifact from [build 40633127654](https://github.com/LamboIsOverrated/azeroth-survivors-re/actions/runs/40633127654). Its archive SHA256 is `b2ebee92c4f4511035043c3745667407ffbd5b213205bde0c73e3bd90e2449bc`. All required checks passed before Railway deployed that gateway. The private core still uses the stock companion binary. The newly compiled movement/bridge binary is being exercised in an isolated restore environment and has not replaced that deployed core.

Observed through ordinary player accounts:

- Two independently signed-in browsers created Human and Orc warriors and entered the shared world. Accounts had game security level zero.
- Both Alliance-to-Horde and Horde-to-Alliance attacks reduced the other player's health in an open-world PvP location. These were attended UI actions; no combat script or GM combat boost was used.
- A five-item food trade completed through both players' trade windows. Authoritative inventory rows then contained zero food on the sender and ten on the recipient, preserving the original total of ten. Both character money balances remained zero.
- The character's equipment and completed introductory quest survived logout, restart and an independent restored-runtime login.
- The updated client remained on character selection for 703 seconds and then entered the world. All 5,079 resident placements completed; the quest log still showed the saved quest. This exercises the actual idle-disconnect fix, beyond its wire-level tests.
- The game toolbar and inventory remain visible at a 1280×720 browser viewport. The wallet panel displays the authenticated character's **last-saved** TEST money and explicitly labels it nonredeemable. An online snapshot is not an authoritative current spendable balance.
- A fresh browser load of the deployed gateway completed wallet refresh without the earlier overlapping-request error and showed the saved character offline after normal logout. The served market bundle matched the reviewed local build by SHA256 (`c62bf5be0c4b2dc240c9824afe99bd9f808899bc7645dab55e05233a154c9729`).

No wallet was connected and no blockchain transaction was performed during these checks. A healthy HTTP endpoint is supplemented by the actual gameplay checks above; it does not establish capacity, complete content coverage or financial readiness.

## Build and recovery evidence

[Bridge build 40649694269](https://github.com/LamboIsOverrated/azeroth-survivors-re/actions/runs/40649694269) at `623c956` passed the pinned currency-mutation census, Node/C++/Python checks, real MariaDB fault fixtures, the full pinned-core container build, actual image ABI/runtime/source smoke, and code-only artifact export. This includes the read-only world login-gate health command and the two narrowly scoped transient-table cleanup grants. That build is evidence for its own source commit. Later commits require their own checks; it does not establish that the new binary has been deployed.

Its tested image is `sha256:d68cba3b94e3bdded74e8dffea52222ea596772b2a40d61bf0e7fadec2a5e796`. The exported code-only archive contains 36 individually verified files and its matching manifest, totaling 47,145,170 bytes as an archive with SHA256 `bdb76d2d3fe95ece947a509eacc7f5836ccd2ffa3e3b78d8e059b070aa9dfa53`. The CI merge tree and feature tree were checked equal before staging those binaries.

The earlier tested image `sha256:040780341f13e130c8badc5cde685bec1d4635beedabf26dacdc7882ab4654e3` supplied the binaries used in the isolated running-world tests. Its feature commit `2e0dd8986f6e5edf1ae5480d1e6407c1805c1339` and CI merge commit `986c45585940c83a384246e3f1d9252c0b88514e` have the same Git tree. Per-file size and SHA checks verified the exported binaries, libraries and source package before staging. No game assets or credentials are in those artifacts.

On that actual isolated world and its CharacterDatabase writer, TEST0 refused changes. TEST1 applied a 75-unit grant and 20-unit debit once each despite identical retries; stale balance, wrong actual realm owner and missing character requests produced durable rejections. An ordinary online player caused a new apply to wait without changing money, receipts or inflight state. A separate test held the character row, observed the writer's lock wait and the durable inflight fence, then terminated only that owned world process before commit. Restart preserved the fence and blocked the same player's world login after successful SRP authentication. The matching typed status proved absence through the writer's locking barrier, cleared the fence, and allowed the same player to enter and log out normally. No manual fence deletion or blind reapply was used.

A final typed debit returned the isolated balance from 55 to zero. Its application HTTP reply was deliberately dropped; status and replay proved exactly one durable application, including after restart. This is application-reply loss, **not** a claim of physically interrupting a COMMIT acknowledgement. Final evidence showed zero money, zero inflight requests, six receipts, offline test players and no bans. These checks exercise the world/FIFO/login boundary, not an end-to-end wallet or funded-token integration.

Private bounded wire checks on that same tested binary also accepted ordinary ground movement, a jump arc, swimming, a server teleport followed by its acknowledgement and legal descent, and actual forced run-speed changes from 7 to 14 and back to 7. An independent observer received both speed changes after the mover's acknowledgements. Invalid distance/height/flight/transport inputs and a measured collision crossing were refused, with ordinary recovery afterwards. The teleport test's first forged packet after its acknowledgement was refused. Both speed-test clients logged out normally; a fresh primary login verified its saved position. These are protocol-level checks using ordinary receiving characters, not full browser acceptance of every movement state.

The attended knockback wire run received the actual server launch and counter, acknowledged it, and relayed two coherent airborne positions. It then deliberately withheld landing/movement for more than 61 seconds to exercise expiry. The first 39-yard forgery after expiry was refused, followed by accepted surveyed-ground recovery, ordinary walking, both normal logouts and a fresh saved-position check. This is a bounded expiry/fence test, **not** continuous rendered flight. Earlier failed tunnel and operator-window attempts remain separate evidence. Browser suspension, airborne speed acknowledgement and real boat lifecycle acceptance remain open.

Recovery work captured all four realm SQL schemas, both web SQLite databases and the matching web master key with writers stopped. Independent restoration checked row fingerprints and decrypted account credentials, then the browser loaded the restored character and quest. The corrected asset copy includes **all regular files**, including extensionless VMap indexes and `.vmo`/`.m2` members. Full integrity verification covered 14 active MPQ inputs, six extractor/configuration inputs and 10,273 extracted output files totaling 2,322,924,825 bytes. The output inventory root is `b3f32d33c91ce23c05fc1efeb021bc78c8bf7f68f765b159dda754ae59d02e15`.

An independent private encrypted copy of all 14 original MPQs, metadata and the exact active overlay was authenticated, decrypted and checked by full file hashes. Encryption keys are outside the backup dataset. Daily and weekly native volume schedules were read back for all three persistent services. Native snapshot workflow completion and a provider-volume restore have not been proved; they must not be inferred from the schedules or from the separate SQL restore.

See [operations](REALM-OPERATIONS.md) for the maintenance, capture and restore procedures. Recorded SQL-copy durations are not full game recovery times; asset transfer and cold world startup take longer.

## Financial and launch gates still open

The wallet links an account through a single-use signed challenge. The internal TEST outbox and closed LIVE accounting kernel remain separate from public settlement routes. All deployed mainnet deposit, withdrawal and game redemption routes remain closed. The CA alone cannot open them.

Before a redeemable launch, complete and independently review:

- Actual C++ integration of every audited money source and sink, including nested quest callbacks, starting money, vendors, trading, mail/COD, auctions, expiry, deletion, imports, GM commands and generic field writers. Positive issuance needs already funded claims; a stock quest reward cannot create redeemable tokens.
- Complete item/quest/loot/mail/auction transactions, durable character/account/login/save/version fences, and multi-owner receipts. The closed accounting kernel's conservation tests do not prove these stock handlers are integrated.
- The server-derived website-account to game-account ownership adapter, durable worker scheduling, pagination, limits, reconciliation and operational monitoring. Website and game account IDs are distinct namespaces.
- Legal forced movement, speed acknowledgements, knockback and real transport lifecycle acceptance before enabling the new movement policy on the deployed core. Private ground/jump/budget/swim/wall tests are narrower evidence.
- A controlled core rollout with the mandatory InnoDB bridge migrations and exact schema/configuration checks, plus rollback and ordinary gameplay acceptance on that deployed binary.
- Scheduled coherent database capture, verified offsite retention, a native-volume restore drill, a useful alert destination, and capacity/soak testing. The current 40-player limit is a configured cap, not a demonstrated load result.
- Final mint/network/decimals validation, immutable token-atom conversion, approved custody/signing, funded treasury and gameplay reward reserves, withdrawal rules and observed solvency. Token-to-SOL exchange also needs an available liquidity route.

These gates describe remaining implementation and operating work as well as launch configuration. They are not satisfied by a passing unit suite, supplying a token address, or renaming TEST gold.
