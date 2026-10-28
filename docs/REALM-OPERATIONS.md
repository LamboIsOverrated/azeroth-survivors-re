# Realm operations and recovery

This runbook describes the private TEST realm. It does not establish production readiness. Opening persistent play beyond the initial preview requires a successful real backup/restore drill, gameplay acceptance and an operating alert path. Mainnet deposits, withdrawals, swaps and redeemable gameplay rewards remain disabled independently of realm readiness.

## Current deployment and observed gaps

Project `d780c744-6457-46c4-b0fb-00e743cc5a93`; environment `pvp-staging` (`806532ec-f778-4dea-b4c2-ebd49d89beee`).

- Web/account service `88c98eb4-2633-46cb-9083-2d0ab45393d1`, private state volume `/state`.
- Core service `59580eed-3a58-4205-a536-078c4d6b561d`, private configuration/extract volume `/realm-data`.
- MariaDB 11.4 service `09604ff1-858a-48a6-b4b8-b87ffe25103d`, private database volume `/var/lib/mysql`.

Read-only Railway API inspection on 2026-10-28 found no existing snapshots and no backup schedules on any of these three volume instances; the project had no storage buckets. No snapshot, restore, schedule or bucket was created during this inspection. Volume usage readings may lag runtime writes; do not use them as evidence that extraction or persistence has completed.

Volume instance IDs, distinct from volume IDs, are web `2218fc81-ba48-432a-8c75-5459ad078b6f`, core `95c106d5-57ba-4c5d-987c-6933594bfe22`, database `b43fe0e6-7085-4ac1-8a8a-fad848a88b64`. Re-discover them after any volume replacement. Read-only inventory uses:

```powershell
railway volume --project d780c744-6457-46c4-b0fb-00e743cc5a93 --environment 806532ec-f778-4dea-b4c2-ebd49d89beee list --json
railway api 'query { project(id:"d780c744-6457-46c4-b0fb-00e743cc5a93") { buckets { edges { node { id name } } } } }' --compact
railway api 'query { volumeInstanceBackupList(volumeInstanceId:"b43fe0e6-7085-4ac1-8a8a-fad848a88b64") { id createdAt } volumeInstanceBackupScheduleList(volumeInstanceId:"b43fe0e6-7085-4ac1-8a8a-fad848a88b64") { kind retentionSeconds } }' --compact
```

## Backup contents and consistency boundary

`deploy/realm/ops/realm_backup.py` requires Python 3.10+, native OpenSSH `ssh`/`sftp`, Railway CLI authentication with an authorized SSH key, and trusted host keys. It uses Railway-generated SSH aliases, checks the runtime project/environment/service IDs, and transfers private files through SFTP. No database password is accepted on its command line. MariaDB clients run in the core container with `MYSQL_PWD` taken from `DB_ROOT_PASSWORD`; client diagnostics are suppressed because they may contain secrets or private SQL.

One archive contains:

- A single `mariadb-dump --lock-all-tables --databases` export of **all four** schemas: `classicrealmd`, `classiccharacters`, `classicmangos`, `classiclogs`. Global read locking covers nontransactional tables as well as InnoDB and prevents separate per-schema snapshot drift. Plan for read-lock duration and enough remote `/tmp` disk for the uncompressed logical dump.
- SQLite online backups of `/state/realm.sqlite` and `/state/economy.sqlite`, including committed WAL data, with SQLite integrity checks. Copying just the SQLite main files is unsafe.
- `/state/master.key`, the 32-byte hex encryption key required to decrypt the game/SOAP credentials stored in `realm.sqlite`. A missing/invalid key fails capture/verification. Do not regenerate it on a restored account volume.
- `/realm-data/config/*.conf`, the pinned source metadata at `/opt/railway-core/upstreams.env`, and the extraction completion fingerprint when available. Configuration contains private database/SOAP settings.
- Per-service deployment/source IDs, a shared snapshot ID, creation time and a manifest with every payload file's size and SHA256.

The archive excludes client MPQs, maps/vmaps/mmaps/DBC payloads, logs, transient setup tokens, operating-system files, database root credentials and MySQL system/grant tables. Keep the operator secret store, source-pinned images and an independently recoverable compatible private client dataset available. Assets must remain private; a source repository or public release is not a backup destination. Extracted assets can be regenerated, but their regeneration time counts toward recovery time. Keep a separate private asset copy if that time is unacceptable.

The separate provider/bootstrap secret store is `C:/Users/illag/Documents/Codex/2026-10-27/i-wa/work/pvp-private.json`, outside Git. Treat its contents as private recovery material: database root/game/web credentials, SOAP operator credentials, and initial web/admin/player password inputs. Preserve it in an owner-only encrypted recovery envelope alongside the verified archive; keep the envelope-decryption key separately recoverable. Reconstruct derived connection settings such as `MARIADB_URL` from that store in the isolated destination, rather than retaining live endpoints in restored configuration. Preserve any later provider-environment changes in the same secret-store workflow. This task did not read or export that store, and the backup tool does not silently collect the entire process environment. No final token mint, treasury signer or wallet private key currently exists to back up. A state archive without its matching out-of-band credential envelope is **not** a complete infrastructure recovery set.

Cross-system consistency requires a **continuous external maintenance/write fence** from before the first check until archive completion. Before capture, close registration/game ingress, disconnect ordinary players, request a normal world save and graceful shutdown, and prevent administrative SQL/SOAP, token settlement or other jobs from writing. Redeploy web and core with `REALM_MAINTENANCE=1` only after their maintenance implementation is deployed and reviewed. The web wrapper must not open the economy SQLite database or spawn the account service. The core wrapper must not initialize databases, extract assets or start auth/world processes. Both loopback `/healthz` responses must report `maintenance: true` and `ready: false` while retaining SSH access.

The tool checks these environment/health proofs and both containers' processes before capture, after each remote capture and again before publishing. Only the exact maintenance wrappers `/app/deploy/realm/web/runtime.mjs` and `/opt/railway-core/runtime.py` are allowed; any account/game/extractor/other Node process, including a paused writer, fails the check. Do not pause a process mid-transaction as a substitute for graceful shutdown. These checks cannot detect an unrelated service or operator writing directly to MariaDB, so the external fence is mandatory. Capture intentionally refuses to run during extraction/initialization. The maintenance flag alone is not evidence that a world save completed.

## Capture procedure

1. Record the current source/image revisions, schema versions, maintenance start time, expected character/account counts and successful world shutdown. Store private evidence outside Git. Make sure no core initialization is active. Keep the existing Survivors preview separate.
2. Put both TEST services into the maintenance state described above. Observe that gameplay listeners/account writes have stopped. Keep MariaDB running. Do not begin if either maintenance proof fails.
3. Prepare a private backup directory **outside every Git checkout**, preferably on an encrypted local disk. The tool creates files with POSIX `0600` and working directories with `0700`; on Windows it applies a protected owner-only DACL before writing private bytes. It refuses existing output files. Archive contents include credentials and keys and are not encrypted by this tool.
4. Create SSH aliases with the current Railway CLI. Use your existing private key with `--identity-file` if needed. Verify `ssh.railway.com`'s host key through a trusted channel first; capture uses `StrictHostKeyChecking=yes` and will not silently trust a new host key. Never put a private key in the repository.

```powershell
railway ssh config --project d780c744-6457-46c4-b0fb-00e743cc5a93 --environment 806532ec-f778-4dea-b4c2-ebd49d89beee --service 88c98eb4-2633-46cb-9083-2d0ab45393d1 --alias pvp-backup-web
railway ssh config --project d780c744-6457-46c4-b0fb-00e743cc5a93 --environment 806532ec-f778-4dea-b4c2-ebd49d89beee --service 59580eed-3a58-4205-a536-078c4d6b561d --alias pvp-backup-core
```

5. Run capture from the repository root. Replace the absolute example destination with your existing private directory. An alternate SSH configuration file can be passed as `--ssh-config ABSOLUTE_PATH`.

```powershell
python deploy/realm/ops/realm_backup.py capture --project d780c744-6457-46c4-b0fb-00e743cc5a93 --environment 806532ec-f778-4dea-b4c2-ebd49d89beee --web-service 88c98eb4-2633-46cb-9083-2d0ab45393d1 --core-service 59580eed-3a58-4205-a536-078c4d6b561d --db-service 09604ff1-858a-48a6-b4b8-b87ffe25103d --web-host pvp-backup-web --core-host pvp-backup-core --output C:/RealmPrivateBackups/pvp-2026-10-28.tar.gz --confirm-quiesced REALM_WRITERS_STOPPED_AND_WORLD_SAVED
python deploy/realm/ops/realm_backup.py verify --archive C:/RealmPrivateBackups/pvp-2026-10-28.tar.gz
```

Capture writes to private temporary paths, verifies the complete archive, then publishes through a no-overwrite hard link. A failed run does not create a completed archive. The destination filesystem must support hard links. Record the final whole-archive SHA256 separately in the private recovery log. Hashes detect corruption, not a malicious archive replacement; accept only backups under operator control. Payload hashes are rechecked while restoring.

Remote private staging lives under `/tmp/realm-capture-<snapshot>-web` or `-core`, with helper `/tmp/realm-ops-<snapshot>.py`. Successful cleanup removes those exact generated paths. If SSH connectivity fails during cleanup, the tool prints the snapshot ID; remove only the matching staging paths after reconnecting. Local temporary state is cleaned on normal failure, but a killed process/host failure can leave private partial files: inspect the private output directory before deleting anything. Never upload private partial archives or diagnostics to a public issue.

6. Keep maintenance active until verification has succeeded. Resume core first, check database/data/login/world readiness, then resume web and verify account access. Record the end of the write fence. A failed backup does not authorize removing the fence before understanding whether the services are healthy.

## Isolated restore drill

The supplied tool **never restores over a live data path or live database by default**. `unpack` requires a new absolute directory named `realm-restore-*`, outside Git; it rejects existing directories, symlinks, traversal, unexpected archive members, duplicate entries, nonregular files and hash/size mismatches. It rechecks SQLite integrity before publishing the new scratch directory.

```powershell
python deploy/realm/ops/realm_backup.py unpack --archive C:/RealmPrivateBackups/pvp-2026-10-28.tar.gz --destination C:/RealmPrivateBackups/realm-restore-2026-10-28
```

Create a **separate empty MariaDB 11.4 process** for the drill. Bind only to `127.0.0.1` on a nondefault port, such as `13307`. Do not point a tunnel at a live database. Use the pinned MariaDB image from `deploy/realm/core/upstreams.env`, an empty scratch volume, and a fresh private password supplied through your secure environment. No source service, public TCP proxy, production webhook or application writer may connect to this scratch instance. The tool deliberately refuses the normal port 3306 and any nonloopback host.

With `MARIADB_ROOT_PASSWORD` already loaded privately into the operator environment, a local Docker example is:

```powershell
docker run --rm --detach --name realm-restore-drill --publish 127.0.0.1:13307:3306 --env MARIADB_ROOT_PASSWORD mariadb@sha256:d1891ede5a559f1086f55053bb8cc1569b0298338c4d72d71725a7f74f6ba620
```

Wait for the isolated database to become ready, then run:

```powershell
python deploy/realm/ops/realm_backup.py restore-sql --archive C:/RealmPrivateBackups/pvp-2026-10-28.tar.gz --destination-host 127.0.0.1 --destination-port 13307 --destination-user root --password-env MARIADB_ROOT_PASSWORD --destination-label drill-2026-10-28 --confirm-isolated ISOLATED_EMPTY_DATABASE:drill-2026-10-28
```

The password value never appears in the subprocess arguments. `SHOW DATABASES` must contain only MariaDB system schemas before import; any preexisting application/test schema refuses the operation. SQL is staged privately and hash-checked before import starts. All four required schemas must exist afterward. An interrupted/failed import leaves a disposable scratch DB; discard it and create a fresh one before retrying. Do not relax the empty-target guard. This tool does not drop databases or redirect a service to the restored copy.

Complete the drill by verifying schema versions and table/row counts against the captured evidence, including ordinary game accounts, characters, inventories, mail, auctions and TEST ledger entries. Recreate limited runtime database principals from the secret store because `mysql` grant tables are intentionally excluded. Run the matching web/core release in an isolated network against the scratch copies and private assets. Regenerate core config for the **scratch** DB credentials/endpoints; copying old core configuration directly could reconnect to the live database. Preserve the recovered `master.key` alongside the recovered `realm.sqlite` and prove that an encrypted game-account credential decrypts without printing it. Verify an ordinary account, expected character/inventory/currency, TEST ledger balance/history, world login, restart persistence and PvP configuration. Disable external settlement and outbound integrations throughout the drill.

Record source snapshot SHA256, tool/source/image revisions, isolated target identity, start/end timestamps, restored counts, decryption result, gameplay observations and recovery duration in the private recovery log. Keep public evidence free of account identifiers and secrets. Delete disposable scratch resources after recording the drill; keep the original backup. Promoting recovered data into service is a separate, deliberate operator action with its own outage and verification plan.

`deploy/realm/ops/recovery_check.py check-web --state ABSOLUTE_RESTORED_WEB_DIRECTORY` supplies a non-disclosing key check after unpacking. It requires the Python `cryptography` package, verifies both SQLite files, decrypts every recovered game-account credential using ChaCha20-Poly1305, checks a stored SOAP credential when present, and emits only integrity results and aggregate counts/TEST journal units. A wrong key or absent game-account fixture fails instead of claiming recovery. It never prints a username, password, ciphertext, key or wallet address. This does not establish that a recovered game password matches a particular live/isolated game server: matching-release login is a separate drill step.

On 2026-10-28 a separate disposable Railway `realm-restore-drill` service (`09bb722b-e45b-4b32-923c-9198c8374fa6`) was prepared in staging using the pinned MariaDB image above, 1 GB memory and 1 vCPU. It has no persistent volume, public domain or TCP proxy; its only database listener was verified as `127.0.0.1:13307`. Only the four MariaDB system schemas existed. Python 3 and `cryptography` are installed in this disposable container so the same restore/check commands can run there over SSH without installing a second database beside the live core. Native strict-host SSH and SFTP were tested. No realm archive had been captured or restored at preparation time. The current target, generated scratch credentials, private staging path and exact pending commands are recorded outside Git in `C:/Users/illag/Documents/Codex/2026-10-27/i-wa/work/realm-recovery/drill-ledger.json` and `drill-secrets.json`; never publish those files. The service definition can appear as an undeployed placeholder in other nonfork environments, but only its staging instance was deployed. Delete this exact disposable service after the drill evidence is recorded; never substitute a source service ID in cleanup.

## Retention and a second copy

Before broader persistent play, configure and verify scheduled volume snapshots as an additional layer. Railway documents daily, weekly and monthly schedules and restores scoped to the same project/environment; these independent volume snapshots do not establish one coherent realm recovery point. Source: [Railway volume backups](https://docs.railway.com/volumes/backups).

The live GraphQL schema was inspected read-only on 2026-10-28. Discovery commands are `railway api describe volumeInstanceBackupScheduleUpdate` and `railway api describe VolumeInstanceBackupScheduleKind`. The schedule update signature is `volumeInstanceBackupScheduleUpdate(kinds: [VolumeInstanceBackupScheduleKind!]!, volumeInstanceId: String!): Boolean!`; both arguments are required and the only accepted enum values are `DAILY`, `WEEKLY`, `MONTHLY`. It takes a **volume instance ID**, not the volume ID or service ID, and has no custom cron/retention input. Read current schedules first and supply the full intended selection. The list query returns `kind` and `retentionSeconds`; verify these server-provided results rather than assuming the logical-archive retention targets below apply to native snapshots. The documented default native retention is 6 days daily, 27 days weekly and 89 days monthly.

Deferred operator example, **not executed here**: after world initialization and the coherent restore drill, the database's intended daily+weekly selection is the GraphQL mutation below. Apply the same desired selection deliberately to the web/core volume instance IDs above, then read back schedules and verify a completed snapshot. Do not snapshot partial maps while extraction is being repaired.

```graphql
mutation {
  volumeInstanceBackupScheduleUpdate(
    volumeInstanceId: "b43fe0e6-7085-4ac1-8a8a-fad848a88b64"
    kinds: [DAILY, WEEKLY]
  )
}
```

Keep coherent logical archives too. Proposed initial operating targets are at most 24 hours of lost progress and recovery within 4 hours; these are targets to measure in the drill, not achieved guarantees. Keep at least 7 daily, 4 weekly and 3 monthly verified archives, and verify available storage before enabling retention. Take an extra coherent snapshot before a schema migration. Never automatically roll a schema backward during an application rollback.

A private [Railway storage bucket](https://docs.railway.com/storage-buckets) is available within the existing vendor and could hold encrypted logical archives. No bucket or offsite upload is configured by this work. A bucket in the same provider/account does not remove that account/provider failure risk. Keep a separately controlled encrypted copy on existing operator storage outside the Railway project, with the archive-decryption key backed up separately. Use an established authenticated encryption tool/key-management arrangement, never a password in a shell argument, public bucket, public GitHub artifact or presigned download URL for these archives. Verify a downloaded second copy by decrypting, checking the recorded SHA256 and restoring it into a new isolated target. Record retention/access/recovery evidence before marking the second-copy requirement satisfied.

The `recovery_check.py` helper also provides streaming AES-256-GCM envelopes using `cryptography`. Prepare private output/key directories outside Git first, with the encryption key in a different directory from the encrypted copy. `seal` creates a random 32-byte envelope key only if it does not exist; an existing key is preserved and must be exactly 32 bytes. Files use the same private permissions and no-overwrite atomic publication as the capture tool. `open` authenticates the envelope before publishing recovered plaintext; tampering or a wrong key leaves no completed plaintext output. The separate key must be independently recoverable: possession of only the encrypted file is insufficient.

```powershell
python deploy/realm/ops/recovery_check.py seal --source C:/RealmPrivateBackups/pvp-2026-10-28.tar.gz --output C:/RealmPrivateBackups/pvp-2026-10-28.encrypted --key-file C:/Users/illag/.codex/recovery-keys/realm-recovery.key
python deploy/realm/ops/recovery_check.py open --source C:/RealmPrivateBackups/pvp-2026-10-28.encrypted --output C:/RealmPrivateBackups/second-copy-verified.tar.gz --key-file C:/Users/illag/.codex/recovery-keys/realm-recovery.key
python deploy/realm/ops/realm_backup.py verify --archive C:/RealmPrivateBackups/second-copy-verified.tar.gz
```

Compare the recovered SHA256 with the separately recorded original SHA256, then use this recovered archive in a fresh isolated restore target. Seal the matching out-of-band provider secret store into a separate envelope with the same private process and preserve its recovery key arrangement. No key or credential value belongs in an argument or public output. Keeping the encrypted copy on the owner's computer supplies a recovery location outside Railway; two files on that same computer do not protect against loss of that computer, so retain a separately controlled existing device/location when available. The helper's fixture tests are not evidence that a real encrypted second copy has been made.

## Readiness and alert evidence

Do not replace these evidence checks with a healthy HTTP port. Check each item explicitly before widening access:

- [ ] Pinned client/core/database builds and schema versions recorded; private compatible assets and all required DBC/maps/vmaps/mmaps validated; initialization complete.
- [ ] Exact public Origin/session/account binding checks pass; database/auth/world/SOAP remain private; ordinary test accounts have GM level 0.
- [ ] Actual browser login, character creation/world entry, two-player visibility/faction PvP, representative vendor/trade/mail/auction behavior and character persistence after a clean restart observed.
- [ ] `GameType=1`, realmlist `icon=1`, build 5875 and bots disabled verified on the active core/configuration.
- [ ] TEST labels/no-carryover policy visible; every real settlement route disabled; no real token transactions or launch-token liabilities created.
- [ ] First coherent backup captured, manifest/SHA256 verified, scratch SQL and SQLite restored, encryption-key recovery and matching-release gameplay drill completed; measured recovery time recorded.
- [ ] Native snapshot schedules present and successful; a separately controlled encrypted archive copy downloaded and restored; access/retention verified.
- [ ] A real owner and alert destination exist; deliberate test failures reach them and recovery clears the alert. Scheduled checks must detect world/database/account readiness failure, restart loops, failed extraction, volume/disk pressure and missing/stale backup completion or restore evidence. Never alert with SQL, environment dumps or credentials.

The repository safety tests are local and fixture-based; they do not satisfy the live backup, restore, offsite-copy or alert-delivery checks. Run them with:

```powershell
python -W error::ResourceWarning -m unittest discover -s deploy/realm/ops/tests -v
```

Verification evidence on 2026-10-28: all 20 operator safety tests passed under Python 3.11.2 in the actual Linux staging core container, including symlink rejection and POSIX `0600` archive/key checks. Only the operator source/tests and synthetic fixtures were staged beneath one private `/tmp/realm-ops-test-*` directory; the test subprocess's temporary directory was confined beneath it. The exact created directory's resolved `/tmp` parent and generated prefix were checked before removal, and its absence was verified afterward. No `/realm-data`, service configuration, active map process, real snapshot or real restore was touched. Windows verification passed 19 tests with the symlink-creation test skipped; the Linux run passed all 20 without skips. This establishes fixture safety behavior, not a completed live recovery drill.

The expanded suite, including credential-decryption and authenticated-envelope round-trip/tamper tests, subsequently passed all 24 tests without skips in the disposable Linux restore service (0.205 seconds). Windows passed 23 with the symlink-creation test skipped. These tests used only synthetic SQLite/credential/archive fixtures under a confined private temporary directory; no source realm snapshot or SQL restore was performed.
