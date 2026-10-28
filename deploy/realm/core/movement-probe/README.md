# Isolated movement wire acceptance

This source-only executable reuses `benilla-protocol` authentication, SRP6,
encrypted header state, movement serialization and acknowledgements. It reads no
client installation, opens no graphics/audio device, sends no combat, chat,
inventory or economy commands, and never connects to a realm-list address.

Run only against a **new sibling patched runtime and disposable cloned schemas**.
Keep the independently verified stock restore intact. The artifact must first
pass the combined Linux image build and smoke checks. An operator must verify
the actual binaries/source/image hashes, `REALM_BROWSER_MOVEMENT_ENABLE=1`,
`Enable=1`, `Warden.Enable=0`, and SQL account security exactly `0` for both
declared accounts. Fixture `security` and provenance fields are recorded operator
attestations; the wire cannot prove an account's SQL security or image digest.
Retain those actual checks beside the transcript. No public realm is a target.

Build from the repository root:

```
cargo build --locked --release --manifest-path deploy/realm/core/movement-probe/Cargo.toml
cargo test --locked --manifest-path deploy/realm/core/movement-probe/Cargo.toml
cargo clippy --locked --manifest-path deploy/realm/core/movement-probe/Cargo.toml --all-targets -- -D warnings
```

The executable accepts `PRIVATE-FIXTURE.json NEW-EVIDENCE.jsonl` and optionally
`--create-only`, `--hold-online`, or `--expect-login-refusal` (one mode only).
Store both outside the client installation, normally in private
`benilla-config/movement/`. The evidence file must not exist. No passwords enter
the fixture, command line or transcript. Export all these variables privately:

```
WOW_USER=MOVEQAONE
WOW_PASS=<private primary password>
WOW_CHAR=Moveqaone
WOW_OBSERVER_USER=MOVEQATWO
WOW_OBSERVER_PASS=<private observer password>
WOW_OBSERVER_CHAR=Moveqatwo
WOW_UNATTENDED=1
WOW_NOSOUND=1
WOW_GM=off
```

The identity variables must exactly match the fixture. The tool requires two
distinct `MOVEQA*` accounts and `Moveqa*` avatars, literal loopback endpoints on
non-stock ports (for example auth `127.0.0.1:13724`, world `127.0.0.1:18085`),
and the disposable database prefix `movementqa_`. Loopback alone does not prove
isolation: the operator must check the tunnel and server configuration.

The separately verified private UI clone uses the actual canonical schema names.
For **that exact copy only**, `database_prefix: "classic"` requires an explicit
`canonical_clone` with all these exact values:

```
service_id: 09bb722b-e45b-4b32-923c-9198c8374fa6
database_host: 127.0.0.1
database_port: 13308
source_database_port: 13307
source_prefix: movementqa_
schemas: [classicrealmd, classiccharacters, classicmangos, classiclogs]
copy_verification_sha256: f86d362c8f1187958b43696ed09b80f70c804b2018750821c5ae4cfac64c94ed
```

The digest binds the operator's private `ui-canonical-db-copy-proof.json` for all
269 copied table row/DDL hashes. This is an operator attestation, emitted in the
preflight; the protocol probe does not connect to SQL or inspect remote service
configuration. Source and canonical databases remain separate. The legacy
`movementqa_` form requires no canonical attestation; mixing it with canonical
metadata fails. Other services, hosts, ports, source names, schema arrays or
digests fail. Dedicated GM0 identities and literal loopback/non-stock game-port
restrictions apply identically. Coordinate the actual forward/configuration
proof with the operator before any canonical UI session.

For fresh accounts, an explicit fixture `create_missing_characters: true`
permits normal `CMSG_CHAR_CREATE` of only the declared avatar on an empty
roster: human male warrior, all appearance indices zero. Existing declared
avatars are reused, never recreated or deleted; an unexpected roster fails.
`--create-only` creates/enumerates both avatars, records their actual map/pose,
then exits without entering the world or sending movement. Use the recorded
poses and operator map checks to prepare the measured fixture. Turn creation
permission off for acceptance runs. Account creation remains an operator task.

`--hold-online` connects **only the primary** ordinary account. It requires an
existing avatar and creation permission off, proves world entry and its measured
pose, emits `online-hold-ready`, and processes normal server/lifecycle replies for
`hold_seconds` (default 20, range 10–60). It ignores the movement steps and sends
no voluntary movement, combat or economy request. The operator coordinates any
separate TEST-only bridge operation after the ready marker. The avatar then
completes normal logout, reconnects to the roster, and verifies the saved pose;
the transcript ends `online-hold-complete`. Each received logout completion is
recorded separately. This mode does not assert the avatar's SQL money or bridge
journal: the operator must preserve those independent observations.

`--expect-login-refusal` connects only the primary, with creation disabled.
SRP must succeed. It records an explicit `CHARACTER_LOGIN_FAILED` result 1 when
that is the server's refusal point, with a subsequent authenticated roster check.
The accepted bridge core also gates `World::AddSession_` **before** registration:
that gate can close the socket during world authentication or the roster instead
of sending a character-login failure. Such an actual peer EOF/reset while reading
a world header is recorded as `world-peer-close-observed`, including its stage.
Timeout, refused dial, bad credentials, queue rejection and malformed packets do
not satisfy that observation. A real local peer-close test exercises this path
through the existing protocol library. Because the library formats its native
read error instead of preserving its type, classification is deliberately limited
to its EOF message and Linux/Windows peer-reset codes; unfamiliar errors fail.

**A peer close alone is not proof of a persistent bridge fence.** Require the
same credentials to enter normally before the controlled fence, the operator's
exact nonempty inflight row and correlated server log while refusal is observed,
healthy listeners, then a normal login after the typed recovery clears that row.
These modes never set TEST flags, issue bridge operations, edit SQL, restart a
server or repair a fence. Do not start a session during another operator's
exclusive drill until that operator coordinates the exact phase.

Copy `fixture.template.json` to private storage. It deliberately fails validation
until `isolated`, the actual source/image hashes, and the measured starting map
and coordinates are supplied. The primary's login world pose must match `origin`
within 0.1 yard; the observer must be within 20 yards and able to see the primary.
The initial positive relay proves that visibility, encryption, mover selection
and the movement path are functioning before a refusal can be interpreted.

Each step sends one allowlisted movement opcode. `offset` is world-coordinate
offset from the measured origin; `delay_ms` is time spent pumping the world
before sending, `observe_ms` is time spent processing replies afterward
(default 200). Bounds are 100–1,000 ms delay, 100–1,500 ms observation, at most
48 steps, and at most 110 seconds for the step schedule. Delays include packet
processing; use transcript elapsed times when judging trajectories. The complete
process has an independent 180-second deadline, 128 streaming writes, and 8,192
inbound packets per peer. Authentication/roster exchanges are separately bounded
by the existing protocol handshake and the overall deadline. No queue wait is
accepted. A deadline exits 124, any other failure exits nonzero.

`flags` uses the pinned CMaNGOS `Entities/Object.h` values. In particular
`MOVEFLAG_FLYING=0x800`, `CAN_FLY=0x800000`, `LEVITATING=0x400`; the
legacy `FLYING_OLD=0x01000000` is a distinct bit and is not this flight test. `jump`, if present, is
`[down-positive vertical speed, cos, sin, horizontal speed]` and requires flag
`0x2000`; `fall_ms` is the declared client fall time. `transport`, if present,
is a GUID with zero local offsets and requires `0x02000000`: this tool supports
the **unknown transport refusal** fixture, not genuine passenger simulation.
Only start-forward, stop, heartbeat, jump, fall-land, start-swim and stop-swim
opcodes are permitted. Arbitrary client opcodes cannot be injected.

A positive step requires the observer's actual `UnitMove` relay for the primary
at that pose. The transcript records local monotonic receipt time, flags and the
uninterpreted wire timestamp; it does not assume the server replaced client time.
A refused position step registers a forbidden pose for the rest of the run, requires
immediate distinct positive recovery, and fails if the observer ever receives
the forged pose. A refused pose may not overlap any planned positive pose.
An optional `clear_flags` mask on a refused flag step permits a corrected relay
only with every specified capability bit removed; any later relay retaining a
prohibited bit fails even at a different position. This mode requires a mask
contained in the requested flags and a position within two yards of origin.
It cannot waive the forbidden-position rule for distance, high Z or collision
attacks. Pinned stock heuristics remove CAN_FLY/LEVITATING and some aura flags
before the custom validator, so a safe corrected ground move is distinct from
accepting a forged capability. Corrected relays are recorded explicitly and
still require positive recovery and saved-position proof.
The last positive returns to origin. The primary must then receive logout
completion and a fresh encrypted login/roster must report the same saved pose.
The observer must also complete logout. Packet silence alone never completes a
successful run.

The template covers a small measured ground walk, excess distance, high Z,
unauthorized flight/water-walk flags and unknown transport. Check its offsets
against the selected floor before use; they are **not a claimed world fixture**.
Add a normal measured jump arc with short intervals, swim in actual water, and
a short wall crossing with endpoints on opposite sides of a verified collision
surface in separate private fixtures. A wall attack should be under the distance
budget so collision, rather than distance alone, explains the refusal. Actual
map checks and server rejection logs must corroborate these cases.

For one phased near-teleport test, a step may specify `await_teleport` with
`destination: [x,y,z]` and `timeout_ms` (1,000–10,000). The expected destination
must be at the measured origin's XY and above its floor by at most ten yards.
The probe emits `operator-teleport-ready` and waits for a genuine server teleport
packet for its primary avatar, within 0.05 yard of that destination. The operator
uses the normal console-safe `tele name` and a temporary measured bookmark.
The probe does not send that command, edit a database or fabricate an ACK state.
Unexpected teleport destinations fail; the expected packet is recorded and ACKed
with its real counter before subsequent movement begins.

Subsequent steps may set `relative_to_teleport: true` to use the actual received
destination. `fall_from_teleport: true` computes a normal zero-initial-velocity
drop from the local monotonic ACK-send receipt time, using the pinned gravity and
terminal speed, clamped at the measured origin floor. It also supplies the elapsed
fall time. This requires no arbitrary Z offset, expires after ten seconds, and
the last step must finish in this fall frame so the saved pose returns to the
original measured floor. A voluntary falling packet still needs the appropriate
flag/jump tail; a landing uses the normal fall-land opcode and flags zero.

Use a positive launch/airborne control to establish the prior air baseline,
then the operator gate, a first 39-yard forged move, an immediate legitimate
drop packet still above the old floor, descent and landing. A bounded gap while
awaiting the operator models delayed movement delivery; it does not establish
continuous rendered-client physics. Count the first forgery only with its native
distance-budget reason after the real teleport ACK, rather than a packet dropped
by an unfinished teleport. Require the legitimate post-ACK airborne relay,
recovery, saved pose, unchanged health and independent operator log correlation.
For an attended speed-change phase, a step may specify `await_run_speed` with
`speed` (1–28 yards/second), `timeout_ms` (1,000–30,000), and optional
`above_floor`. The `operator-speed-ready` marker names the expected run speed.
The private in-game operator selects the ordinary primary and uses normal
`.modify aspeed 2`, then a separate checkpoint restores `.modify aspeed 1`.
For an unmodified level-one avatar these run speeds are 14 and 7. The probe ACKs
each actual force-change packet's kind, counter and exact speed. Completion
requires the observer's corresponding run-speed relay after that ACK, not just
the server's request. Received counters, ACK poses and observer poses are logged.
Before a speed phase, the actual self create's native run-speed field must be
received and equal seven; `initial-self-run-speed` records it. A stale runtime
speed or missing create field stops before the attended action prompt.

If the server teleported the avatar into a drop, speed ACKs use the current
receipt-clock fall position and preserve falling flags/tail. `above_floor: true`
requires both the ACK position and the observer relay to remain more than two
yards above the old floor; a slow operator action fails rather than claiming a
midair test after landing. Restore the speed through the normal operator UI even
if a test fails, and keep both ordinary avatars at security zero. These gates
wait for external attended actions; the probe sends no privileged command.
For a separately attended knockback phase, `await_knockback` names an expected
`launch: [down-positive Z speed, cos, sin, XY speed]` and a 1,000–120,000 ms timeout.
`operator-knockback-ready` is the only action prompt. The operator must first
verify the actual runtime spell template has only the non-damaging knockback
effect and no damage/aura/trigger effects. The intended single attended cast is
10689, with the operator east of the primary to launch west into surveyed ground.
The received encrypted `KnockBack` packet must match the ordinary avatar, finite
direction and bounded expected launch. The probe records and ACKs its real
counter/quad; it sends no cast, privileged command or combat action.
Only this prelaunch attended wait can exceed 30 seconds. Its excess reserves at
most 90 extra seconds in the whole-process watchdog and schedule, making their
maximum deadline 270 seconds. Flight and expiry clocks still start exclusively
from the actual received launch, with the same bounds. Speed and teleport action
windows, health/combat, packet, terrain and movement checks are unchanged.

`relative_to_knockback` uses the last accepted primary pose. With
`ballistic_from_knockback`, the offset must be zero, flags must be falling, and
the jump tail comes exclusively from the actual server launch. Up to two seconds
of trajectory uses its monotonic receipt clock, the pinned gravity and terminal
speed. A private `terrain` grid provides measured ground heights, interpolated
without extrapolation; its source map name/SHA are operator attestations that
must match the verified server files. No assets are bundled or modified. The
running server still verifies every proposed collision, floor and trajectory.

The expiry fixture sends positive ballistic samples, then
`wait_knockback_age_ms: 61000` pumps replies without a voluntary landing/swim
packet until that age on the actual receipt clock. This deliberately models a
stale client withholding landing; it is not continuous rendered motion. That
step must be a negative move in the knockback frame. The 61–65 second wait counts
against the overall schedule and independent deadline. Require a first forged
move refusal after the wait, `ground_from_knockback` recovery on surveyed ground,
and ordinary `terrain_follow` walking back to origin. The last step must complete
that return. Preserve actual native rejection reasons, positive relays, health,
security and saved-position evidence before claiming the world test passed.

The probe watches received ordinary-avatar health and `UNIT_FLAG_IN_COMBAT`.
Combat or a health change aborts; an unintended combat cast cannot silently
continue as an unattended physics test. Unexpected world transfers, unconfigured
or mismatched knockbacks still fail. Full transport boarding/detach, taxi, slow fall,
resurrection, and midair reset acceptance therefore remain separate world/client
gates. Do not turn those missing runs into a pass from model tests.
The dedicated level-one self stream must initially report the attested 60 HP
before actions. Health baselines are separate for the self and observer streams:
pinned `Object.cpp`'s Fog of War can send the observer percentages rather than
absolute hit points. Both streams still abort on combat or a change from their
own baseline; sparse absent health fields do not reset it. Evidence records the
receiver side, player GUID, health/max-health values and unit flags before each
health check, including an abort.

On the pinned source, modify-speed/aspeed, cast and aura commands require an
in-game selected-player session (`allowConsole=false`). Some debug entries claim
console support but dereference `GetSession()->GetPlayer()` (including transports
and dbscript variants). Do not use these through SOAP or alter permissions to
force a physics test. An attended private operator UI or a separately verified
normal noncombat mechanism is required for those actions. The ordinary test
avatars retain security zero throughout.

Correlate every negative send with the dedicated character and actual isolated
world log `Browser movement rejected: REASON` (or an identified stock validation
refusal). Confirm no ban/kick/silence and no unrelated players. Preserve source
manifest, private fixture hash, complete JSONL, exit code, server log segment,
GM/security/config checks, and saved-pose result together. The tool ends with
`wire-checks-passed`, explicitly leaving server reason correlation and other
fixtures outstanding; this is not a production-readiness verdict.

For an attended browser boat test, `--observe-player` logs in **only** the
declared dedicated `observer`, using `WOW_OBSERVER_USER/PASS/CHAR`. It never
reads or uses the attended actor's credentials, sends voluntary movement, or
logs in the fixture's primary account. Keep both declared QA identities and all
existing endpoint/clone guards. Set `steps: []`, creation off, no terrain grid,
and `observation: {"guid": ACTUAL_PLAYER_GUID, "seconds": 60}`. The GUID must be
a nonzero player low GUID, distinct from the observer, and duration is 10–90
seconds. The observation fixture and explicit mode must match; another mode
cannot accidentally run it. The ordinary observer must already stand at the
measured `origin` on the declared map. Place it only through the operator's
normal private-clone fixture procedure, after coordinating exclusive access.

`observer-ready` is the attended action prompt. The tool records the watched
player's received world pose/flags/wire timestamp and, when present, the exact
transport GUID, deck-local pose and local orientation. No coordinate transform
or transport path is inferred. Transport creates include their received pose,
progress anchor, entry/type and rotation fields. Each record also has the
probe's monotonic receipt time. Name queries identify the watched GUID without
logging in that player. Out-of-range and destroy events are explicit coverage
gaps. A stationary dock observer can lose sight during a ride or map transfer;
that portion requires separate attended actor evidence or a destination capture.
The capture must contain at least one actual player movement relay to exit
successfully. Object creates alone cannot satisfy it.

The observer logs out normally and reconnects only to verify **its own** saved
pose. `observer-complete` explicitly leaves actor persistence unverified and
reports movement/gap counts. Preserve the actor's attended boarding, ride,
disembark and normal logout with read-only server saved-pose/log evidence before
claiming transport acceptance. No observation-only run emits `wire-checks-passed`.
The independent 180-second deadline and packet ceilings remain in force.
