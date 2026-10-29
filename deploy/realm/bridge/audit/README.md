# Pinned core money mutation audit

This is an internal, offline source-review gate. It introduces no world hook,
route, worker, import into accounting, chain transaction, credential or LIVE
enable switch. **A passing source audit does not make money reserve-backed.**

The baseline is the official [CMaNGOS Classic source at
de8f72993b9e1faa1bf92dd5505f3daec5cea3ce](https://github.com/cmangos/mangos-classic/tree/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce).
All source line references below refer to that unmodified revision. The twelve
previously pinned bridge source hashes also match this archive. No world assets
or account/database contents were used.

## Executable review gate

From the repository root:

```text
python deploy/realm/bridge/audit/check_mutations.py --source /path/to/exact/unmodified/core --json
python -m unittest discover -s deploy/realm/bridge/audit/tests -v
```

The checker never fetches source, executes the core, connects to a database or
writes to the source tree. Exit 0 means the reviewed source bytes, source file
set, discovered review sites and business/helper classifications match. Exit 1
requires source review; exit 2 is invalid input/manifest.

`expected-sites.json` contains SHA256 for **2,208 files** in `src/`, `dep/`,
`cmake/`, `contrib/`, `doc/`, `CMakeLists.txt` and `sql/base/characters.sql`, plus **226 review
sites**. It rejects missing, added and changed covered files, including an
added bypass whose syntax the token scanner does not recognize. Symlinks in
covered source are rejected. `event-map.json` separately classifies all 61
money API occurrences and the direct starting-money write. The gate rejects
omitted classifications. Fixtures exercise changed callsites, direct writes,
alternate bypass spelling, new files, missing files, wrong pins, traversal,
escrows, generic field writers, SQL and omitted event policy.

The 226 review sites are: 61 money API occurrences, 5 coinage-field references,
44 money/escrow assignments, 43 writes/deletes involving characters/mail/auction
tables, 56 generic field-writer surfaces and 17 raw update-field array writes.
These numbers **are not 226 independent currency mutations**: declarations,
getters, local variables, loading and helper primitives are deliberately
included. The full concrete API/event census is:

- **40 `ModifyMoney` call expressions**, plus its inline definition. Five calls
  are bot-only: four in `PlayerbotAI.cpp` and the bot-hire branch in Player.cpp.
- **4 direct `Player::SetMoney` callers**: three GM branches and player load.
- **1 direct starting-money update-field write** outside `Player::SetMoney`.
- **9 `MailDraft::SetMoney` callers** which create or move mail escrow.
- **1 `TradeData::SetMoney` caller**, setting an offer without moving money.
- **7 helper/declaration occurrences**, including the two SetMoney calls inside
  ModifyMoney. In total, 54 business API callsites + 7 helpers = 61; the direct
  starting-money field write makes 55 classified event sites.

This is a strict baseline gate: an already patched bridge core intentionally
fails it. Run it before applying reviewed carries, then check the complete
carry diff and its patch hashes separately. A future approved money carry
needs its own independently reviewed post-patch manifest; do not regenerate
the baseline merely to silence a failure. The tool is not a C++ AST proof and
cannot validate external SQL, configured scripts, database restores, arbitrary
runtime process access or a malicious edit to its trusted review manifests.

## Why a replacement ModifyMoney hook is insufficient

`Entities/Player.h:1387-1397` exposes **void**, saturating helpers. Negative
changes clamp at zero and positive changes clamp at MAX_MONEY_AMOUNT; callers
receive no rejection result. This can also silently discard received money at
the cap. Changing the helper to ignore an unfunded credit would leave callers
continuing after partial item/quest effects; changing its return type alone
does not make those callers check it.

Examples at this pin:

- Vendor sale removes/decrements the item and changes buyback state before the
  credit (`ItemHandler.cpp:571-591`). Rejecting only the credit loses the item.
- Quest reward consumes required items at Player.cpp:12548-12551, grants reward
  items/reputation and clears the quest slot before its two money changes at
  12599/12602. Both amounts belong to one checked event.
- Trade moves both inventories at TradeHandler.cpp:432-448 before four money
  calls at 470-473. Independent debit/credit reservations are unsafe.
- Bank and stable slot counts change before the debit
  (`ItemHandler.cpp:916-917`, `NPCHandler.cpp:861-862`). Pet/talent/profession
  spells are removed before their debit (see the caller map below).
- Mail take-money sends success before ModifyMoney and unconditionally clears
  mail money (`MailHandler.cpp:521-532`). At a cap or rejected credit that can
  destroy the backed escrow without delivering the full claim.

Preflight must therefore be a typed, checked result **before the first
irreversible gameplay side effect**, with one final durable result for the
entire event. Unknown outcomes retain their reservation and fence. Financial
failure must not be inferred from a timeout or an empty query.

Money application can also re-enter gameplay: SetMoney calls MoneyChanged
(Player.h:1397), which can call CompleteQuest (Player.cpp:13652-13670); an
auto-rewarded quest then calls RewardQuest (12525-12527). A general thread-local
"money changes allowed" capability would authorize nested, unreserved changes.
Bind application authority to exact participants, versions, event legs and
amounts. Stage nested reward events separately or include them in the prepared
plan; do not let callbacks silently inherit the outer reservation.

## Complete business caller implementation map

### Starting money, loading, administrative and script paths

- `Entities/Player.cpp:827`: creation writes CONFIG_UINT32_START_PLAYER_MONEY
  directly into PLAYER_FIELD_COINAGE. Create with zero, or reserve the complete
  starting grant from a funded system pool before creation/save. New-character
  identity and its creation event must survive retries; never adopt stock money
  as backing. CharacterHandler.cpp:512 subsequently saves the new player.
- `Entities/Player.cpp:14066-14069`: load clamps saved money and SetMoney applies
  it. This is hydration of an existing claim, **not issuance**. Validate account,
  namespace, exact money and version against allocation before releasing login.
  Reject unexplained stock money or a mismatched owner; do not normalize it into
  a fresh credit.
- `Chat/Level1.cpp:1211,1221,1231,1233`: HandleModifyMoneyCommand directly clears,
  sets or changes selected-player money. Deny this command for backed currency,
  or replace it with a distinct, authenticated, funded administrative event.
  Its success messages occur before the mutation and need to move after result.
- `Chat/Level3.cpp:4883`: GM quest completion grants required quest money by
  negating a negative requirement. Treat as privileged issuance; preflight the
  complete quest-completion helper before it creates quest items/progress.
- `Chat/Level3.cpp:6491`: HandleSendMoneyHelper sets money on mail drafts used by
  individual/mass administrative mail. Each actual recipient needs a funded,
  unique event and mail escrow; validating a mail prototype once cannot fund an
  arbitrary mass-mail fanout.
- `DBScripts/ScriptMgr.cpp:2842`: SCRIPT_COMMAND_SEND_MAIL sets arbitrary
  configured money. Reserve before the script sends the mail and persist a
  script-invocation/recipient identity. Positive mail money is funded issuance
  unless it explicitly transfers an existing escrow.
- `AI/ScriptDevAI/scripts/world/npc_professions.cpp:566,586,606`: leatherworking
  specialization unlearning; CastSpell and ProfessionUnlearnSpells precede the
  sink. Preflight at the successful affordability branch before either effect.

Generic bypasses also need an explicit deny/authorization boundary:

- `DBScripts/ScriptMgr.cpp:1827,1888,1902` FIELD_SET/FLAG_SET/FLAG_REMOVE only
  enforce general field bounds. They can address a player's coinage field.
- `Chat/debugcmds.cpp:809,819,1038,1053,1089,1103-1104,1114,1137-1140` write selected-object
  fields by index/name, integer/float/byte/short or bit operations. Administrative
  status is not reserve backing. Deny coinage and any overlapping wide write.
- `Entities/Object.cpp:809,847-1064` contains raw field loading and primitive
  setters/flags. A defensive sink guard must cover **every overlapping index**,
  including a uint64 beginning at COINAGE-1, byte/short writes, float aliases,
  flags and raw loading. Guarding only Object::SetUInt32Value misses other raw
  writers. Preserve a narrowly scoped private capability for validated load,
  zero creation and already prepared application; generic script/debug access
  must never obtain it.

### Loot and quests: newly issued claims

- `Loot/LootMgr.cpp:2263,2273`: grouped and solo Loot::SendGold. Before
  NotifyMoneyRemoved at 2251, quote the actual eligible online recipients,
  floor/remainder and caps, reserve their **aggregate** payout from a funded loot
  pool, and fence that loot instance and all recipients. Complete allocation,
  m_gold=0 at 2281 and any item-loot state/destruction as one event. A group loop
  must not pay its first members and then discover the pool is empty.
- `Entities/Player.cpp:12599,12602`: max-level XP-to-money reward plus normal
  signed quest reward/requirement. Preflight at RewardQuest entry (12544), after
  eligibility checks and before consuming required items. Use checked integer
  arithmetic for the final quoted game units; the stock float rate/casts are
  not ledger amounts. Include quest items, status/reward flag, reputation, XP,
  mail and callbacks in the event plan. Repeatable quests need an invocation
  identity; a quest ID alone is not an idempotency key.

### Vendors and service sinks

- `Entities/ItemHandler.cpp:591`: vendor sale. Reserve funded vendor payout
  before the split/full removal at 571/586 and buyback insertion. Item GUID,
  stack count, vendor, quote and buyback state belong to the event.
- `Entities/Player.cpp:17574,17594`: vendor inventory/equipment purchase; check
  item capacity/equipment eligibility first, then reserve its full sink before
  StoreNewItem/EquipNewItem, vendor stock updates and response. Existing
  `GetMoney()` checks are not reservation/fence checks.
- `Entities/ItemHandler.cpp:624`: buyback sink; reserve before removing the
  buyback item and storing it. Preserve any funded vendor/buyback pool policy.
- `Entities/Player.cpp:4685`: paid durability repair before 4689 item durability
  write. DurabilityRepairAll loops over items: either prequote one atomic whole
  repair, or use explicit per-item events with accurate partial-result policy.
- `Entities/NPCHandler.cpp:294`: trainer sink before spell learning/casting and
  success response. This opcode is PROCESS_THREADSAFE at Opcodes.cpp:462, so its
  preflight cannot assume it already runs on the global world thread.
- `Entities/Player.cpp:3791`: talent reset; reserve before removeSpell loop at
  3782. `no_cost` resets still need ordinary gameplay serialization.
- `Entities/PetHandler.cpp:708`: pet unlearning; reserve before unlearnSpell
  loop at 689 and resetting points/action bars.
- `Entities/ItemHandler.cpp:917`: bank slot; reserve before 916 count update.
- `Entities/NPCHandler.cpp:862`: stable slot; reserve before 861 increment.
- `Entities/PetitionsHandler.cpp:136`: charter sink plus item and petition DB
  changes. Preflight before StoreNewItem and any subsequent petition replacement.
- `Guilds/GuildHandler.cpp:757`: guild emblem sink; include guild emblem state
  in the event before SetEmblem and success response.
- `Entities/Player.cpp:17344,17359`: initial/subsequent taxi route charges. Total
  affordability is checked at 17124, but subsequent charges happen on route
  callbacks. Reserve the complete trip before flight begins, with durable leg
  progress/refund policy. A late refusal inside the route-end void callback is
  too late to prevent service delivery.

### Transfers and existing escrow claims

- `Trade/TradeHandler.cpp:470-473`: one two-player transfer with all item moves,
  trade spell/reagent effects and versions. Preflight before 432, lock both
  participants in deterministic order, verify both post-trade caps, and commit
  both money/item snapshots and one event receipt together. Its stock final
  save group is 489-492. The individual calls must not issue from reward pools.
- `Trade/TradeHandler.cpp:661` calls TradeData::SetMoney (Player.cpp:424): this
  is only an offer. Invalidate/recheck accepted offers after participant state
  changes. Moving ledger funds at offer time requires explicit release rules.
- `Mails/MailHandler.cpp:217,219,262`: the silenced-postage-only sink and normal
  money+postage send. Atomically move attached money into a uniquely identified
  mail escrow; postage goes to a system pool. Preflight before the success at
  214, debit, item removal and MailDraft. Stock SendMailTo commits its own mail
  transaction at Mail.cpp:318-330, while sender inventory/gold saves happen in
  another at MailHandler.cpp:266-268. They are not one atomic transfer today.
- `Mails/MailHandler.cpp:475,479`: COD checkout transfers buyer money into a
  payment-mail escrow and delivers the item. Preflight before mail item removal
  at 439; include sender-existence policy, COD=0, recipient inventory and new
  mail together. The payment mail is currently sent before the buyer debit,
  outside the final 489-492 save group.
- `Mails/MailHandler.cpp:523`: withdraw attached mail money into character money;
  it is a conserved escrow transfer. Check full receiver capacity before 521,
  then clear mail money and save gold/mail together. Stock group is 529-532.
- `Mails/MailHandler.cpp:394` and `Entities/Player.cpp:4138`: mail return and
  deletion-time COD mail return carry existing escrow. No new issuance. A
  missing sender needs a defined retained/recovery owner, not a silent burn.
  Explicit return currently deletes original mail before separately creating
  its returned draft (MailHandler.cpp:368-394).
- `AuctionHouse/AuctionHouseHandler.cpp:317`: listing deposit moves to auction
  escrow. AddAuction removes inventory before its save group
  (AuctionHouseMgr.cpp:680-694). Include deposit, item and listing atomically.
- `AuctionHouse/AuctionHouseMgr.cpp:788,793`: same-bidder incremental or new-bidder
  full bid hold. Include old-bid escrow release into refund mail, new bidder
  debit, auction version and optional buyout completion. The old refund mail at
  796 commits separately before the auction/gold group at 808-812.
- `AuctionHouse/AuctionHouseHandler.cpp:161,186`: outbid/cancel refunds move held
  bid claims to mail. `AuctionHouseMgr.cpp:202` sale proceeds are existing bid +
  deposit - auction cut; they are **not vendor-sale issuance**. Apply cut to a
  system pool, release exactly the existing escrows, and ensure a single durable
  auction terminal outcome.
- `AuctionHouse/AuctionHouseHandler.cpp:447`: cancel-with-bid fee sink; refund
  and item mails precede the final auction deletion/save group at 461-464.
  AuctionBidWinning likewise sends result mails before 769-773 deletion/save.
  Expiry, missing owner/bidder, cancellation and restart must share the same
  durable terminal-event identity and retained-claim policy.

### Disabled bot paths

- `Entities/Player.cpp:11880`: bot-hire cost after LoginPlayerBot.
- `PlayerBot/Base/PlayerbotAI.cpp:4671`: pickpocket payout.
- `PlayerBot/Base/PlayerbotAI.cpp:5929,6347`: bot item sales.
- `PlayerBot/Base/PlayerbotAI.cpp:7859`: bot skill cost.

Keep ENABLE_PLAYERBOTS/BUILD_AHBOT off as required by the current bridge.
AuctionHouseBot uses AddAuction with no player and UpdateBid with a null bidder,
creating synthetic auction money without ordinary player debits. Disabling
only these five explicit calls does not make bots safe for a backed economy.

## Save, login, deletion, expiry and import boundaries

`Player::SaveToDB` deletes/reinserts the complete character row including money
(Player.cpp:15544-15581) and queues related saves before CommitTransaction at
15709. SaveGoldToDB performs an unconditional money update at 15732-15733;
SaveInventoryAndGoldToDB at 15722 has no own transaction. Old queued saves can
overwrite a newer balance or reintroduce a deleted/changed owner. Fence/version
checks must apply to every save path and persistent character lifecycle, not
only to browser requests or a recently read `online=0` column.

`Database.cpp:390-431` starts a thread-local transaction list and queues it at
CommitTransaction. Its return is not a durable world receipt.
CommitTransactionDirect ignores Execute's result and returns true.
`SqlOperations.cpp:46-67` does not check BeginTransaction. A production adapter
needs checked Begin/Execute/read-back/Commit on the existing CharacterDatabase
writer, with no automatic reconnect or replacement connection mid-event.

MapManager.cpp:193-208 waits for map workers, and World.cpp:1696 subsequently
processes CLI commands. Some service opcodes are map-thread-safe while trades,
mail and AH are thread-unsafe (Opcodes.cpp). A global event staging queue can be
consumed at the post-map barrier; do not synchronously wait on that queue from
a map worker while the world waits for that worker. The current TEST bridge
uses whole-world emptiness, which cannot accept ordinary online gameplay.

Hard deletion at Player.cpp:4182-4202 removes money and receiver mail rows;
soft deletion at 4207 changes account ownership to zero. Account deletion
(Accounts/AccountMgr.cpp:91), character deletion, old-character cleanup, GM
restore/reassignment and import must acquire the same fence. Decide and persist
where each existing world/mail/auction claim goes before deleting/unlinking.
Character deletion must never make a pending reservation refundable merely
because its row has disappeared.

ObjectMgr::ReturnOrDeleteOldMails at 6118 deletes expired rows at startup (6124)
and maintenance (6216), or switches sender/receiver and clears COD (6198).
Those paths can drop existing money without any ModifyMoney call. Mail delete,
missing-player mail, expired auction and item cleanup require the same escrow
conservation/recovery policy. Mail SQL schema still uses its own money column;
character-only total reconciliation omits it.

`Tools/PlayerDump.cpp:401-672` imports complete character/mail rows through
dynamic SQL with a separate transaction; it does not require existing backing.
Deny stock pdump import and raw balance/account restores for LIVE namespace, or
build an audited namespace-preserving restore/reconciliation protocol first.
Restoring a MariaDB snapshot without the matching financial journal can replay
claims. Database world scripts/configuration are external inputs not established
by this source snapshot and must be separately allowlisted/versioned.

## Minimal next event/fence contract

Introduce a closed trusted C++ event interface before changing callers:

```cpp
enum class MoneyEventKind { FundedIssue, SystemSink, Transfer, EscrowMove };
enum class PreflightResult { Prepared, Rejected, Pending };
struct Participant { AccountId account; CharacterGuid guid;
    MoneyUnits before; MoneyVersion version; GameplayStateHash state; };
struct MoneyLeg { ClaimOwner from; ClaimOwner to; PositiveMoneyUnits units; };
struct MoneyEvent { ServerEventId id; NamespaceHash namespaceHash;
    MoneyEventKind kind; GameplayReason reason;
    std::vector<Participant> participants; std::vector<MoneyLeg> legs;
    GameplayPlanDigest plan; };
```

These are proposed types, not an implemented API or activation mechanism.
Avoid a caller-supplied `backed=true`, generic positive delta, SQL string,
browser-authored event ID or publicly constructible mutation capability.

1. **Quote and stage:** world-owned gameplay code validates eligibility, computes
   exact bounded integer deltas and item/quest/service effects, allocates the
   unique event ID, and stages the immutable plan. `Pending` yields safely before
   effects; `Rejected` leaves all participant state untouched.
2. **Reserve and fence:** acquire all character/escrow/loot/auction fences in
   deterministic order. Validate account, namespace, money and gameplay versions.
   New positive claims reserve an already funded pool; all other legs transfer
   existing claims. Persist the reservation and immutable plan before apply.
3. **Apply once:** world owner rechecks the quote/fences, writes complete gameplay
   changes, money, versions, new escrows and a bound receipt in one checked
   CharacterDatabase transaction. Work must be queued behind older saves; no
   later unversioned save may cross the persistent fence. Update/publish memory
   and success packets only under the same owned event, with a defined durable
   recovery plan if publication is interrupted.
4. **Acknowledge:** settle the financial batch from the matching durable receipt,
   then durably acknowledge before releasing world fences. Duplicate events
   return the identical receipt; unknown commit status keeps all claims reserved
   and participants fenced. Crash/restart/login/expiry handlers obey the fence.

The current accounting kernel supports one-character vault/pool operations; it
does **not** yet provide this atomic multi-character/escrow event contract.
Transfers, mail and auction support require a reviewed extension to the journal
and adapter. Calling prepareWorld independently for each leg is insufficient.
Also provide explicit zero-cost/no-op results for normal gameplay; do not submit
zero amounts to the positive-unit accounting API.

Prioritize rejection-before-effects fixtures for sale/quest/trade/COD and cap
handling, then real CharacterDatabase FIFO, map-thread, disconnect, commit-ack,
older-save, restart, deletion and two-account fault drills. Keep LIVE closed
until the actual gameplay adapter and conservation checks pass these gates.
