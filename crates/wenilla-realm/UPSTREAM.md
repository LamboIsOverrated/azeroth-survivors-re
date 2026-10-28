# Realm source provenance

Imported from [Arnesen/wenilla](https://github.com/Arnesen/wenilla/tree/d68dcc539460e8fc5169105c790443489d91ca76/crates/wenilla-realm),
commit `d68dcc539460e8fc5169105c790443489d91ca76`, directory `crates/wenilla-realm`.
The source archive was retrieved from GitHub's commit-addressed codeload endpoint.
Only this crate's source, templates, and tests were imported; no game install assets.
The repository's MIT OR Apache-2.0 licenses apply; original authorship is preserved
in the source and pinned upstream history. Local changes add split-service config,
TEST labels, a private identity endpoint and a protocol-bound relay.

`REALM_REMOTE_CONFIG=1` is required when the core owns its own volume. In this mode
the web setup creates only a web admin and uses the operator-provided `SOAP_URL`,
`SOAP_BOOTSTRAP_USER`, and `SOAP_BOOTSTRAP_PASS`. It never rotates the console,
changes realmlist or edits core files. Config/preset endpoints are disabled.
The core service owns its configuration and non-GM account defaults.

Use `REALM_BIND=127.0.0.1:8090`, `REALM_STATE_DIR=/state`,
`CLIENT_DATA=/state/client/Data`, `REALM_WWW=/app/www`, and the public HTTPS
origin in `REALM_PUBLIC_URL`. Set `MARIADB_URL` to the dedicated read-only
realmweb account, and both `REALMD_HOST` and `MANGOSD_HOST` to the private core.
Keep `REALM_COOKIE_INSECURE` and `WENILLA_DEV_QUERY_CREDS` unset in hosted use.
Back up `realm.sqlite` and `master.key` together.

The relay accepts only an exact configured Origin and authenticated session.
It parses complete Vanilla SRP challenge/proof/list messages and the first
world AUTH_SESSION message before forwarding them. Their account must match
the session's provisioned game account; reconnect auth messages are rejected.
The authoritative core still verifies SRP and the world session digest.
This does not claim gameplay anti-cheat or live two-player verification.

The pinned core's [WorldSocket.cpp](https://github.com/cmangos/mangos-classic/blob/de8f72993b9e1faa1bf92dd5505f3daec5cea3ce/src/game/Server/WorldSocket.cpp#L209)
closes a connection on a second AUTH_SESSION and validates its digest against the
named account's SRP session key. The relay depends on that core behavior after
validating the initial plain world handshake; later headers are encrypted.

`GET /api/character-balances` returns only the authenticated provisioned account's
characters, with exact decimal `moneyUnits`, `online`, and `snapshot: last-saved`.
No browser account or character identifiers are accepted. These are TEST game
units, not an onchain balance or a redeemable vault. The MariaDB fixture test uses
`TEST_BALANCES_MARIADB_URL` and session-local temporary tables in a disposable DB
with `classicrealmd` and `classiccharacters` schemas and CREATE TEMPORARY TABLES
permission. Without that environment the fixture explicitly skips.

Browser builds: `WEB_VARIANT=mmo scripts/web-build.sh` produces `web/dist` from
`wenilla` (ordinary `run`); `WEB_VARIANT=survivors scripts/web-build.sh` produces
`web/dist-survivors` from `wenilla-survivors` (`run_survivors`). `WEB_DIST` overrides
the output folder when packaging the separate preview. Both emit the stable
`wenilla.js` / `wenilla_bg.wasm` names expected by their own pages.

Active relays revalidate the stable session ID and session nonce every 15 seconds,
with a five-second lookup deadline. Logout, disabled/expired sessions and database
errors close both transports within at most about 20 seconds. Cookie rotation
preserves the session identity. Provisioning refuses unknown existing core
accounts; restore matching web state or recover them explicitly rather than
silently resetting their password and claiming ownership.

Password changes compare the credential hash again at commit time and replace all
old sessions atomically, including the current session, with a fresh cookie and
CSRF nonce. No previous-token grace survives. Middleware does not overwrite the
replacement with a rotation cookie created earlier in the request. Resets revoke every session atomically;
password-based login inserts a session only while its verified hash remains
current. Reset passwords are shown once in a no-store HTML response, never in a
redirect URL. SOAP transport errors and empty replies fail closed; ambiguous
password changes require operator reconciliation rather than overwriting saved
credentials with an unverified value.

Migration 0005 preserves existing account IDs and ownership rows and adds the
AUTOINCREMENT sequence so deleted IDs cannot be assigned to future users. It runs
before requests are accepted, on a dedicated migration connection with foreign
keys temporarily disabled for the parent-table rebuild. A foreign-key integrity
check must pass before runtime connections open with foreign keys enabled. This
prevents future identity reuse; any historical ownership corruption from an older
installation requires a separate audit rather than an inferred repair.
