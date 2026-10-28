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

Run `python -m unittest discover -s deploy/realm/core -v` for portable safety
checks. A Linux container smoke test with real MariaDB is still required before
production deployment. No compatible data is included in these tests.
