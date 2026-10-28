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
Speed-change packets are acknowledged from the latest accepted pose and recorded;
they require a separate audited normal server trigger for a speed-reset drill.
Unexpected world transfers and knockback fail closed because this version does
not synthesize passenger or forced trajectories.
Full transport boarding/detach, knockback/withheld landing, taxi, slow fall,
resurrection, and midair reset acceptance therefore remain separate world/client
gates. Do not turn those missing runs into a pass from model tests.

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
