# Private Vanilla TEST PvP core

Build the standalone context with `docker build deploy/realm/core`.
The Railway source root directory must be `/deploy/realm/core` with Dockerfile
path `Dockerfile`; do not inherit the repository root's Survivors railway.json.
Use one replica and a persistent `/realm-data` volume. Keep the service private:
never create public TCP proxies for 3306, 3724, 8085 or 7878. Stop timeout must be
at least 60 seconds so the world can save characters before termination.

Required environment:

- `DB_HOST`, `DB_PORT` (default `realm-db.railway.internal`, `3306`).
- `DB_ROOT_PASSWORD`, `DB_MANGOS_PASSWORD`, `DB_REALMWEB_PASSWORD`: separate generated
  secrets, 12-128 characters from A-Z/a-z/0-9/underscore/hyphen. This restriction
  prevents ambiguity in the core's semicolon-separated database configuration.
- `REALM_DOMAIN`: private core hostname, default `realm-core.railway.internal`.
  Maximum 32 characters, matching the pinned Classic database address field.
- `SOAP_ADMIN_USERNAME`: separate uppercase operator account, 3-16 alphanumeric or
  underscore characters. Seeded example account names are rejected.
- `SOAP_ADMIN_PASSWORD`: generated 12-16 alphanumeric characters (Vanilla limit).
- `PORT`: status listener, default 8080. `EXTRACT_THREADS`: default 2, max 64.
- `REALM_MAINTENANCE`: `1` starts only the Python status wrapper; default `0`
  starts the normal realm. Other values are rejected before initialization.
- `CORE_PLAYERBOTS_COMPILED`, `CORE_AHBOT_COMPILED`: image capability metadata,
  each exactly `0` or `1`. Both default to `1` for the existing pinned companion
  binary. They describe compile options, and do not enable bot gameplay.
- `REALM_BRIDGE_TEST_ENABLE`: exactly `0` or `1`, default `0`. Explicit TEST
  enablement is accepted only when both compiled bot capabilities are `0`.
  Only this validated TEST switch is forwarded to the game; root database,
  SOAP operator and LIVE settlement variables remain absent from game children.
- `CORE_BROWSER_MOVEMENT_COMPILED`: image metadata, exactly `0` or `1`, default
  `0`. `REALM_BROWSER_MOVEMENT_ENABLE` is a separate strict `0`/`1` activation
  gate, default `0`; enabling it on the ordinary unpatched image fails closed.

The web service must use the same SOAP credentials against private port 7878,
and `realmweb` plus `DB_REALMWEB_PASSWORD` for read-only auth/character queries.
Ordinary player creation is through SOAP with security level 0. The separate
operator account alone gets GM level 3; upstream's four seeded accounts are
locked and their verifiers/session keys erased on every boot. Browser-compatible
anti-cheat is disabled; no redeemable reward economy is enabled by this package.

The default command is `serve`. It waits for MariaDB, installs the pinned Classic
DB only when **every** target schema has zero tables, reapplies scoped runtime
grants and PvP realm metadata, then waits for extraction. Game listeners run as
the image's mangos UID/GID 10001 with a minimal environment containing no database
or operator secrets; generated core configuration supplies its scoped SQL login.
Only configuration/log permissions are adjusted before launch. Existing healthy
databases are preserved. A partial/interrupted schema fails closed and requires
private operator repair/restore; it is never automatically erased or replaced.
Failed initialization leaves `/status` at `initialization-failed` and readiness
false while retaining SSH access. SQL errors are recorded with mode 0600 at
`/realm-data/logs/database-error.log`; public logs show only the error number.
Take all four database backups before schema changes. The upstream installer
builds PlayerBots tables even with its flag off; all bot runtime settings remain
disabled. Bootstrap root credentials are not passed to the game processes
through generated configuration; only the bootstrap helper receives them.

After game launch begins, a child exit or supervisor error stops the sibling,
closes HTTP and the volume lock, and exits nonzero so Railway's `ON_FAILURE`
policy can restart the realm. Only a failure before game launch uses the
indefinite operator repair hold. Completed extraction markers survive retries.

To initialize data, privately stage the complete compatible client install under
`/realm-data/client/Data` (preserve the patch chain and locale directories), then
create `/realm-data/client/.input-ready` **after** transfer/validation finishes.
The running supervisor starts extraction automatically. It runs `ad`, vmap
extraction/assembly, then movement maps with checked exit codes. Read progress
from `/status` and `/realm-data/logs/extract-*.log`. Each successful phase has a
marker tied to the pinned core and input inventory; restarts skip completed
phases and the upstream movement-map generator can reuse completed tiles.
Do not change the input inventory during extraction. All outputs and markers
stay on the owned volume. Normal builds never extract or download game data.
Full movement-map generation can take hours. If deliberately operating outside
serve mode, `python3 /opt/railway-core/runtime.py extract` runs the same extraction
and `initialize` only bootstraps SQL; stop serve first because a volume lock
prevents concurrent initializers. A serving process never treats partial data
directories as a completed extraction.

`GET /healthz` reports supervisor liveness, including while data is missing.
`GET /status` gives database, data, login, world and SOAP states.
`GET /readyz` returns 503 until schema checks, completed data extraction and all
three actual TCP listeners pass. This does not prove browser world entry or
PvP; those require separate interactive acceptance. Status has no admin actions.

For a coherent operator backup, set `REALM_MAINTENANCE=1` and restart/deploy the
core through its ordinary graceful stop procedure. This is a startup fence,
not a live command: wait for the previous world/extractor process to exit and
its character saves to finish. The replacement process starts only Python
status HTTP, without reading database credentials, creating volume/config/lock
files, checking SQL, extracting MPQs, or launching login/world/SOAP children.
The flag overrides even explicit `initialize` and `extract` modes. `/healthz`
and `/status` return HTTP 200 with `maintenance: true`, `phase: "maintenance"`,
`ready: false` and every component readiness false; `/readyz` returns HTTP 503.
This matches the backup tool's maintenance proof. Use the normal wrapper
command (`python3 /opt/railway-core/runtime.py` or its `serve` mode) for backup
process inspection. Quiesce the web writer separately before capture. Return
the flag to `0` and restart after backup/restore work is finished.

Run `python -m unittest discover -s deploy/realm/core -v` for portable safety
checks. A Linux container smoke test with real MariaDB is still required before
production deployment. No compatible data is included in these tests.

## Audited candidate-input repair

The measured candidate's ZIP CRCs pass, but its nested patch entry
`World/Maps/Kalimdor/Kalimdor_33_49.adt` cannot be fully decompressed. It declares
1,196,952 bytes and returns only 393,216 bytes. The returned prefix is byte-for-byte
identical to the structurally valid 1,196,952-byte entry in `terrain.MPQ`. All 2,200
ADTs in the two patch archives were audited; this was the sole malformed entry.
The original unpatched extractor then completed dbc/maps and both vmap phases
after the backed repair. Movement maps and gameplay require separate completion.

`repair_client.py` accepts only the exact sizes and SHA256s of all 14 audited MPQs
and validates the exact prefix, full entry hash, all ADT chunk bounds, and a
round trip through a copied highest-priority patch. Unknown inputs fail closed.
It makes original MPQs read-only, hardlinks unchanged entries into a separate
directory, copies/amends `patch-2.MPQ`, and atomically publishes the derived tree
and `.client-data.json` containing every MPQ's name/size/SHA256 and the repair proof.
Original MPQ contents are never rewritten. Both extractor and browser must use
the same derived input. The original extractor hardcodes patches through
`patch-2.MPQ`; adding `patch-3.MPQ` does not override its input.

Install Debian `smpq` (tested 1.6-2 with `libstorm9` 9.22-1), then run:

```sh
python3 /opt/railway-core/repair_client.py --source /realm-data/client-source/Data --output /realm-data/client/Data
touch /realm-data/client/.input-ready
```

The web image can copy `repair_client.py` and `adt_repair.py` together, install
the same package, and run with `--source /state/client/Data --output
/state/client/DerivedData` after private data staging, pointing the realm's
`CLIENT_DATA` at the derived directory. All output remains private runtime data.
Run the helper on every startup and after restoration, even when a size-based
completion check succeeds. It hashes every original and derived MPQ, rejects
missing/extra archives, duplicate/path-valued manifest filenames, changed bytes
of the same size, and unknown manifest versions. The marker cannot authorize a
different overlay: its expected SHA256 is pinned in source alongside all other
file hashes. Manifest version 2 identifies source version
`vanilla-5875-enUS-audited-candidate-20261028-v1`. Existing normalized version-1
helper output is verified in full before only its marker is upgraded; MPQ
contents remain untouched.

The normalized patch is exactly 9,597,150 bytes with SHA256
`9f9e27a09374d1f669dfe280c1d8c0c9dd148c8d89237c6b58a701bc9e1b3c5e`.
Two independent fresh derivations at different times reproduced these bytes
using the tested StormLib packages and a fixed entry modification time. A
different tool output fails closed until its source profile is deliberately
reviewed. The earlier manual operator overlay has identical restored game
content but different container metadata; it is not accepted as this normalized
profile. Migrate such input into a new directory during planned maintenance,
without changing an active extractor's fingerprint. Source hashes and entry
proof are metadata only; no game content is in Git.

## Future bot-free bridge image: not deployed or activated

The ordinary standalone `Dockerfile` keeps the pinned companion image's compiled
module capabilities. With capability `1`, the matching module template must
exist before any configuration is written, and the matching `-p` or `-a` option
is passed. A missing declared module template fails closed. With capability `0`,
the template is optional, no module configuration is generated, and its option
is omitted. Existing module settings always keep bots disabled.

A future reviewed bridge image has a separate repository-root build context:

```sh
docker build -f deploy/realm/core/Dockerfile.bridge -t realm-core-bridge:test .
```

### Browser movement carry: activation remains disabled

The same future image applies `browser-anticheat.patch` after the disjoint bridge
carry. `apply_anticheat.py` requires the exact core revision and hashes of all
six affected source files, verifies patch/header hashes, checks applicability,
and verifies the resulting source hashes. It never touches SQL or a service.
The complete patched source, carry, header, apply tool and build checks accompany
the future binary image. The ordinary pinned companion image has capability `0`.

The pinned stock core parses `Warden.Enable` but does not use it: constructing an
enabled anticheat session unconditionally constructs Warden, sends its module,
and delays character enumeration for fingerprinting. The carry makes Warden
optional, guards every Warden call, and directly sends character enumeration
when it is disabled. Unsolicited Warden traffic is rejected. It also makes all
movement validators mandatory in sequence and removes the stock blanket
zero-coordinate teleport exemption.

The movement policy consumes horizontal distance from a per-player budget refilled
only by the server's monotonic receipt clock and authoritative run/swim/walk
speeds. Its burst allowance is two seconds of movement plus one yard; it never
uses a submitted client timestamp. Server timer wrap is supported. Root/stun state
comes from the server's unit state. There are no packet-level teleport, taxi,
knockback or spline exemptions. The authoritative teleport callback resets the
budget and air origin from its server destination; the next packet still passes
all ordinary distance, collision and physics checks. Speed acknowledgements leave
that baseline intact and use the common movement validator once. Transport
membership grants no blanket exemption: the transport must exist in the current
map, match any active passenger membership, and produce the claimed world pose
within ten yards. Offsets have symmetric bounds; accepted world coordinates are
rebased to the server transform. Boarding requires proximity and a physical
surface. Passenger motion consumes the same budget in local coordinates, and
airborne checks use local Z so moving lifts do not create artificial flight.
Frame changes translate an existing air origin using the authoritative previous
pose without resetting its clock or granting distance. Budget, air and frame
changes are staged in copies and committed only after every validator accepts.
It corrects or rejects unpermitted flight/movement flags, map collision crossings and positions
below the server's map surface. An airborne ceiling uses the pinned gravity,
jump and terminal-velocity constants, with a corrected seven-yard terminal speed
for feather fall. Server aura changes reset only the air baseline;
two yards of tolerance remain. Surface contact uses the server's map and explicit
in/under-water status bits, excluding the core API's above-water state. Existing teleport checks also
remain mandatory. Rejections leave character position unchanged and record bounded
reason notifications through the existing anticheat counters/log database.

Knockback records its server origin, receipt clock, direction and velocities.
Incoming positions must match a coherent flight time inside a bounded two-second
receipt window, a two-yard trajectory corridor, normal collision and map-surface
checks. A verified first collision can end flight only near its server-computed
hit point. A verified landing clears launch state without requiring LAND/SWIM;
withheld opcodes cannot preserve an exemption. The world update expires any
remaining envelope after sixty seconds and reanchors at the existing server pose.
Actual knockback timing, wall/ceiling impacts, long falls and aura changes remain
mandatory isolated-world tests before activation.

Knockback ACKs for enabled ordinary sessions require an actual outstanding server
counter and finite matching launch quad. Registration precedes counter increment;
the first native counter may be zero. The ACK stages a candidate, then the shared
ordinary budget/air/LOS/floor path validates its origin before relocation. Only
full acceptance consumes it and starts the exact server trajectory at that
validated origin. Trajectory time starts at ACK application; absolute authority
still expires sixty seconds after the original server issue. Replayed, superseded,
wrong or expired receipts cannot reanchor it. A geometry refusal leaves the
receipt available for a fresh valid ACK. Null/disabled policy retains stock ACK
behavior; teleport and world re-entry discard pending receipts.

The exact-source native helper exercises moving-victim origins and delayed ACKs,
but this follow-up needs a fresh full image and actual moving-victim world drill.
Legacy informational `OverspeedZ` false positives remain documented; their
idle-JUMPING heuristic does not justify an exemption or punitive response.

Enablement generates `Enable=1`, `Warden.Enable=0`, speed diagnostics and log-only
heuristic response masks. No generated heuristic action bans, silences or kicks.
Packet refusal is implemented in the source carry, rather than inferred from a
log threshold. The image declares its capability but leaves activation at `0`.
Do not enable it until the combined image build and isolated real-client movement
acceptance pass. Model/dispatch tests cannot establish real map or browser fidelity.

Portable checks cover strict activation gates, source/hash/path rejection and the
unchanged default image. The C++ executable exercises normal movement, bursts,
tenfold speed, timer wrap, root, server teleport, finite values, jumping and hover
refusal. `check_anticheat_dispatch.py SOURCE` extracts and compiles the actual
patched dispatch/character-enumeration/Warden-packet and authoritative reset,
teleport, expiry and speed-ack methods with narrow engine boundary fakes. It checks
validator order, refusal short-circuiting, post-teleport rejection, midair reset and Warden
absence/presence; it fails against the original pinned movement dispatcher.
Teleport resets read the already updated authoritative player world pose, never
the callback argument, which is local for far transport teleports and world for
ordinary teleports. Regression cases cover both frames and an airborne passenger.
The Docker builder runs both checks before compiling the full core.

The isolated world drill must use disposable restored schemas and ordinary test
accounts, with no unattended combat. Check run/walk/backpedal/strafe/turn/jump,
stairs/doors/caves, swim, ledges/falling, slow fall, mount/speed changes, root and
server movement, taxi/transports/lifts, blink/hearth/resurrection and server-issued
teleports. Verify forged clock changes, high-rate short steps, long/zero-axis
teleports, flight flags, air hovering, large Z and nonfinite positions cannot
move the authoritative character or create bans. Confirm recovery after a refused
packet and measure latency/burst tolerance. Actual maps, transport ownership,
collision and aura paths require this evidence before public PvP can be released.

Its Dockerfile-specific allowlist includes only named source, patch and metadata
files; the repository root `.dockerignore` is untouched. The build checks the
exact core revision and bridge source hashes before applying the source patch,
compiles auth/world with current and deprecated PlayerBots and AH bot support
OFF, then layers only `realmd` and `mangosd` over the immutable companion base.
The pinned extractors, their format versions, SQL and Classic DB remain in place.
Image metadata sets both bot capabilities to `0` and TEST enablement to `0`.

The image build runs `smoke_runtime.py`: generated runtime arguments are parsed
by actual new `mangosd --help` and `realmd --version`, compiled PlayerBots
support is checked against the declaration, optional module configuration is
checked, and a real Linux maintenance process must have no child processes and
serve maintenance/503 readiness. These checks require no SQL or game assets.
For source CI outside the image, set `CORE_PLAYERBOTS_COMPILED=0` and
`CORE_AHBOT_COMPILED=0`, install the CMake build to scratch, and set
`CORE_SMOKE_MANGOSD`, `CORE_SMOKE_REALMD`, `CORE_SMOKE_TEMPLATES` to that install
before running `python3 deploy/realm/core/smoke_runtime.py`.

The image contains a complete already-patched core/submodule source archive at
`/opt/railway-core/source/cmangos-bridge-source.tar.gz`, the exact patch and
pinned-input manifest, and this build recipe. To rebuild the included source,
unpack it and run the recipe's CMake configure/build/install commands without
reapplying the already included patch. Preserve upstream GPL source and license
material when redistributing binaries. No client assets or credentials enter
the build context or source archive.

**Do not deploy this image from compilation alone.** The reviewed bridge schema
migration at `/opt/railway-core/source/bridge/core/001-world-bridge.sql` must be
installed manually during maintenance; missing bridge tables intentionally deny
logins in the patched core. Real MariaDB commit/disconnect/restart, queue drain,
login-race and account-isolation acceptance remain required. TEST enablement is
a separate explicit operator action only after those checks and whole-realm
quiescence; this package never turns it on automatically and passes no LIVE flag.
