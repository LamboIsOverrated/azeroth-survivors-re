# Private Classic core image

The runtime extends the public companion image pinned in `upstreams.env`. The
registry OCI index, amd64 manifest and image config were read on 2026-10-28.
The config labels identify companion revision `b56f79bf699c874c14d8c16423eda4220f05f76e`
and Classic DB revision `4d230bb1bd477948cac61c107d2718b3ea04a5b8`.
The companion's [exact upstream pins](https://github.com/Arnesen/wenilla-realm/blob/b56f79bf699c874c14d8c16423eda4220f05f76e/upstreams.env)
identify the core and PlayerBots revisions recorded alongside the digest.
Its [source build recipe](https://github.com/Arnesen/wenilla-realm/blob/b56f79bf699c874c14d8c16423eda4220f05f76e/docker/mangos.Dockerfile)
builds unpatched CMaNGOS, PlayerBots and extractors and carries the SQL and Classic
DB installer. The pinned companion checkout plus those exact build arguments
reproduce its source inputs; Debian package repositories are not snapshot-pinned,
so a rebuilt source image is not claimed to have an identical digest.

CMaNGOS Classic is GPL-2.0-or-later; Classic DB is GPL-3.0-or-later; the companion
is MIT. Preserve their license files and supply the corresponding source when
redistributing binaries. The base's auto-generated OCI license label says
NOASSERTION, which does not replace upstream licenses. Source links:

- [CMaNGOS exact source](https://github.com/cmangos/mangos-classic/tree/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce)
- [Classic DB exact source and installer](https://github.com/cmangos/classic-db/tree/4d230bb1bd477948cac61c107d2718b3ea04a5b8)
- [PlayerBots exact source](https://github.com/cmangos/playerbots/tree/31e0f32b543fee46941db51225bb7b432eace236)
- [SRP6 calculation](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/shared/Auth/SRP6.cpp)
- [Extractor command reference](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/contrib/extractor_scripts/ExtractResources.sh)

No game-install assets, extracted server assets, accounts or secrets are included
in this repository or image. Runtime data comes only from the operator's private
compatible Vanilla 1.12.1/build-5875 client input.

## Measured private-input repair

On 2026-10-28, the pinned extractor reproducibly received SIGSEGV in
`adt_MCIN::prepareLoadedData` while reading `Kalimdor_33_49.adt`. GDB file-entry
tracing isolated the tile. StormLib `smpq` 1.6-2 reported an unreadable patch entry
after 393,216 bytes despite a declared 1,196,952-byte size; its partial bytes match
the same-length prefix from a valid complete lower-priority terrain entry.
The corresponding map entry from the terrain archive has SHA256
`9e7809c00fab5177e89b3597cb784bdb9fc1dc07abc66b2ffcaccfdc1d9b0611`;
the identical partial prefix has SHA256
`7b1898d8709b0084f55f339f4293397c19a70fb5267087017de8b67e0a1472f6`.
The source-only repair helper pins complete original archive hashes, restores
only that proved identical entry in a copied highest patch, and records private
runtime manifests. Other inputs are rejected. All original files remain present
and read-only. An audit of 2,200 patch ADTs found no second invalid entry.
No client entry, MPQ, extracted map, or other game asset is committed or published.

## Complete source identity and deterministic derived identity

The original private derivation recorded SHA256s for all 14 MPQs before and
after preserving the immutable originals. `repair_client.py` now pins that
complete name/size/hash inventory as source version
`vanilla-5875-enUS-audited-candidate-20261028-v1`; this identifies the measured
candidate rather than asserting publisher authenticity. ZIP CRC validation
remains a transport check and does not replace these pinned content hashes.

On 2026-10-28, two independent fresh private scratch derivations, started at
different times, each produced a 9,597,150-byte normalized `patch-2.MPQ` with
SHA256 `9f9e27a09374d1f669dfe280c1d8c0c9dd148c8d89237c6b58a701bc9e1b3c5e`.
The helper sets the restored entry timestamp to epoch zero and uses StormLib
`smpq` 1.6-2 / `libstorm9` 9.22-1 with ZLIB compression. The other 13 derived
MPQs must match their complete original hashes. Manifest version 2 records
all these content identities and is verified on repeat runs and restores.
The initial manual operator overlay's 9,597,162-byte container differs only in
metadata and remains distinct from the reproducible normalized profile; its
restored ADT has the same independently verified full-entry hash.

## Separate future bot-free bridge image

`Dockerfile.bridge` builds the exact same core revision after the reviewed
`deploy/realm/bridge/core/world-bridge.patch` is checked against its pinned input
file hashes. Current/deprecated PlayerBots and AH bot compile features are OFF.
Only the newly built `mangosd` and `realmd` replace the immutable companion
image's binaries; its same-revision extractors and resources are retained.
Image capability metadata makes the wrapper omit unavailable module templates
and CLI flags, while the normal image retains its original capabilities.

The future image includes the complete already-patched upstream/submodule code
in `/opt/railway-core/source/cmangos-bridge-source.tar.gz`, the source patch and
manifest, its application tool and the build recipe for corresponding-source
redistribution. The recipe uses a Dockerfile-specific source allowlist, following
[Docker's context documentation](https://docs.docker.com/build/concepts/context/#filename-and-location),
without changing the repository's root ignore file or including any assets.
SQL migration remains manual, TEST enablement defaults to zero, and no LIVE
settlement setting is forwarded. Full source/image build and real database fault
acceptance are mandatory before deployment; portable configuration tests alone
do not confirm the new image has been built or is safe to activate.

## Disabled browser movement carry

`anticheat-sources.json` pins the exact before/after hashes of the original core's
`libanticheat.cpp`, `Movement/movement.cpp`, `Movement/movement.hpp`, the shared
`Anticheat.hpp` interface, `module/libanticheat.hpp`, and the native movement
handler at the core revision above. `browser-anticheat.patch` is the reviewable source carry and
`BrowserMovementBudget.h` is original server-clock budget/airborne-ceiling code.
The apply tool verifies both source and carry content and accepts the separate
bridge's earlier modifications only because they touch disjoint files.

Primary mechanisms were checked directly in the exact pinned
[anticheat dispatcher](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/game/Anticheat/module/libanticheat.cpp),
[Warden constructor](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/game/Anticheat/module/Warden/warden.cpp),
[movement checks](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/game/Anticheat/module/Movement/movement.cpp),
[configuration parser](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/game/Anticheat/module/config.cpp)
and [server movement handler](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/game/MotionGenerators/MovementHandler.cpp).
The stock Warden switch is parsed without a consumer; the stock movement dispatcher
returns before teleport validation on success; speed excess is accumulated without
an enforcement consumer. The carry does not attribute its new movement policy to
stock CMaNGOS behavior. Full image compilation and isolated actual-world acceptance
are independent release gates. Activation stays explicitly disabled until those
gates pass; no deployment or real-world protection is established by source tests.

Two additional exact-source seams are handled explicitly in the carry. Pinned
`Movement/util.cpp::computeFallElevation` selects a slow-fall terminal but its
terminal-time/terminal-segment expressions still use normal terminal velocity;
the new envelope preserves its constants and honors the seven-yard-per-second
slow-fall terminal. Pinned `GridMap.cpp::TerrainInfo::IsInWater` treats any nonzero
liquid status as water, including `LIQUID_MAP_ABOVE_WATER`; the carry instead
requires explicit in/under-water bits. These corrections are checked as source
mechanisms and modeled physics, with actual browser/world acceptance still pending.

Pinned `MovementHandler.cpp::HandleMoverRelocation` can attach a submitted
transport GUID without a proximity check. The carry therefore validates the
current-map transport, passenger ownership, symmetric offset bounds and local to
world transform before using it. Boarding charges distance to the server-rebased
position, and subsequent passenger movement charges relative distance; transport
membership is never a global budget/physics exemption. Actual ship/lift boarding,
latency and jump acceptance remain explicit isolated-world gates.

The follow-up carry removes `_justTeleported` and `IsLaunched()` as browser
validation exemptions. `HandleTeleport` consumes the authoritative destination
to reset the budget and airborne origin; speed acknowledgements no longer consume
stock movement state ahead of the common validator. Knockback uses server-clock
origin/direction/velocity envelopes with coherent XY/Z flight time, mandatory map
checks and opcode-independent landing/expiry. Transport frame changes translate
air origins without resetting their time. Source tests compile the actual reset,
teleport, expiry and speed-ack methods, while standalone models cover withheld
landing, timer wrap, trajectory forgery and world/local air-frame changes. Full
image and isolated actual-world acceptance remain separate prerequisites.

The native knockback follow-up registers the exact server order before its
counter increments and supplies the previously missing opcode/ACK response map.
The default interface hook retains Null/stock policy behavior. Enabled ordinary
self-controlled sessions stage only a matching finite counter/launch quad;
absent, replayed, superseded, expired and malformed receipts stop before movement
processing. Teleport and world re-entry discard pending receipts.

While the receipt is pending, the unchanged ordinary budget/air state and shared
LOS/floor/transport path validate the ACK's application origin. Successful
geometry/policy acceptance consumes the receipt once before player relocation.
It debits that ordinary displacement and anchors the exact server trajectory to
the accepted origin. Trajectory application time and original server issue time
are separate: delayed ACKs do not strand legal flight, and cannot extend the
absolute 60-second server authority. No client clock grants time or distance.

`check_knockback_contract.py` compiles the actual native Send/ACK, module gate,
receipt staging and complete shared browser validator against narrow map/engine
boundaries. Native regressions exercise the first counter zero, negative receipt
and geometry cases followed by a fresh valid ACK, a 3.493-yard moving-victim
origin, and a three-second delayed ACK followed by legal flight. They are not
real map or network acceptance; a new full image and isolated moving-victim
drill remain required. Inherited `OverspeedZ` diagnostics still use the older
idle-JUMPING distance heuristic; their informational false positives are retained
and documented rather than granting a flag-derived exemption or enabling bans.
# Complete generated-data attestation

`extraction-profile.json` contains metadata only. Its Linux amd64 extractor
profile pins all fourteen active input archives, the four extractor binaries,
the unchanged upstream extraction configuration, and the off-mesh input. The
accepted output is every regular file under `dbc`, `maps`, `vmaps`, and `mmaps`,
including `.vmo`, `.m2`, and extensionless files: 10,273 files / 2,322,924,825
bytes. The SHA256 of sorted compact JSON `[relative POSIX path, size, SHA256]`
vectors is `b3f32d33c91ce23c05fc1efeb021bc78c8bf7f68f765b159dda754ae59d02e15`.

The independently copied restore matched every file, then loaded the saved
character and quest in the browser. The new verifier separately checked the
complete source and generated trees on the running realm in read-only mode;
profile SHA256 `225b6b4fffd7ca3230b8f7379a47fd34b107213833c953d97eeeb7fd7e24837f`.
That check did not write or upgrade the running realm's legacy marker.

Startup verifies all bytes before launching game processes. A legacy marker
can be sealed only when sources, tools and the complete output root match the
accepted profile. Missing files, same-size corruption, extra files, changed
extractors and unknown sources keep the realm closed for repair. Unchanged
archives may link only to their exact immutable original names; the repaired
`patch-2.MPQ` may link to its exact private overlay. All linked bytes are hashed.

The active first extraction used the manually derived `patch-2.MPQ` (9,597,162
bytes, SHA256 `0991580c474caf7e70e187447829ce1deec8e65ea8654d9a275050b6934665ca`).
Preserve that exact private overlay with the immutable original archives for
recovery. The later normalized helper emits different archive metadata; do
not substitute it into this accepted extraction profile without separately
checking the complete resulting output tree and reviewing its profile.

