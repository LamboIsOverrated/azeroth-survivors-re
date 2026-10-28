# Browser realm acceptance record

Status recorded on 2026-10-28. This is a running **TEST realm**, not a production launch or a guarantee of defect-free operation. TEST characters, items and currency do not carry into the future redeemable economy.

## Deployed browser realm

[Open the TEST realm](https://realm-web-pvp-staging.up.railway.app/). The original Survivors preview remains a separate deployment. Accounts are managed through the realm administration page; private operator credentials are kept outside Git.

The deployed web runtime uses the source-built `a3ff560` MMO artifact from [build 40633127654](https://github.com/LamboIsOverrated/azeroth-survivors-re/actions/runs/40633127654). Its archive SHA256 is `b2ebee92c4f4511035043c3745667407ffbd5b213205bde0c73e3bd90e2449bc`. The private core still uses the stock companion binary. The newly compiled movement/bridge binary is being exercised in an isolated restore environment and has not replaced that deployed core.

Observed through ordinary player accounts:

- Two independently signed-in browsers created Human and Orc warriors and entered the shared world. Accounts had game security level zero.
- Both Alliance-to-Horde and Horde-to-Alliance attacks reduced the other player's health in an open-world PvP location. These were attended UI actions; no combat script or GM combat boost was used.
- A five-item food trade completed through both players' trade windows. Authoritative inventory rows then contained zero food on the sender and ten on the recipient, preserving the original total of ten. Both character money balances remained zero.
- The character's equipment and completed introductory quest survived logout, restart and an independent restored-runtime login.
- The updated client remained on character selection for 703 seconds and then entered the world. All 5,079 resident placements completed; the quest log still showed the saved quest. This exercises the actual idle-disconnect fix, beyond its wire-level tests.
- The game toolbar and inventory remain visible at a 1280×720 browser viewport. The wallet panel displays the authenticated character's **last-saved** TEST money and explicitly labels it nonredeemable. An online snapshot is not an authoritative current spendable balance.

No wallet was connected and no blockchain transaction was performed during these checks. A healthy HTTP endpoint is supplemented by the actual gameplay checks above; it does not establish capacity, complete content coverage or financial readiness.

## Build and recovery evidence

[Bridge build 40636766955](https://github.com/LamboIsOverrated/azeroth-survivors-re/actions/runs/40636766955) at `aba712b` passed the pinned currency-mutation census, Node/C++/Python checks, real MariaDB fault fixtures, the full pinned-core container build, actual image ABI/runtime/source smoke, and code-only artifact export. That build is evidence for its own source commit. Later commits require their own checks.

The earlier tested image `sha256:040780341f13e130c8badc5cde685bec1d4635beedabf26dacdc7882ab4654e3` supplied the binaries used in the isolated running-world tests. Its feature commit `2e0dd8986f6e5edf1ae5480d1e6407c1805c1339` and CI merge commit `986c45585940c83a384246e3f1d9252c0b88514e` have the same Git tree. Per-file size and SHA checks verified the exported binaries, libraries and source package before staging. No game assets or credentials are in those artifacts.

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
