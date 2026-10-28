# Realm TEST economy module

Requires Node 24 and the dependencies from `deploy/realm/package-lock.json`. Run `npm ci --prefix deploy/realm` and `npm run build --prefix deploy/realm` from the repository root. Serve generated `public/realm-wallet.bundle.js` and `public/realm-wallet.bundle.css` at the corresponding root URLs; load the JS module on the authenticated `/play` page. The wallet panel only mounts on `/play`.

```js
import {createEconomy} from '../economy/api.mjs';
const economy = createEconomy({identity, getCharacters, dbPath:'/state/economy.sqlite', env:process.env});
// identity(req) must derive {id,username,isAdmin} from the realm session, never browser headers.
if (await economy(req,res)) return;
// On graceful shutdown after stopping incoming requests:
economy.close();
```

Required: `PUBLIC_ORIGIN`, an exact HTTPS origin with no trailing slash. Loopback HTTP is accepted for local testing only. Optional: `ECONOMY_TEST_ALLOCATION_UNITS` defaults to `0` (disabled); positive values up to `1000000000` permit a one-time self allocation. An authenticated administrator may allocate their own account once using a decimal-string `units` field; players cannot choose amounts or account IDs. Configuration changes, logins, wallet reconnects and process restarts do not reset allocations.

Optional read-only chain display: `ECONOMY_SOLANA_RPC_URL` must be a fixed HTTPS endpoint. `ECONOMY_TOKEN_MINT` is optional, syntactically checked, and explicitly **not** verified as a live launch mint. RPC credentials are never returned to the browser. Balances use finalized RPC reads and exact strings; an RPC SOL balance that has already lost precision is rejected. These are display-only chain assets, not deposits or backing for TEST units.

All `/api/economy/*` requests require a valid realm identity. Mutations additionally require the exact configured Origin, JSON content type, and `x-realm-economy: 1` to block cross-site form requests. Responses are private/no-store. IDs, wallet linkage, vault balances and history always come from the authenticated account. Wallet linking verifies a real Ed25519 signature over an exact account-, wallet-, domain-, nonce- and expiry-bound message. The challenge is consumed atomically and persists across restart. A wallet can belong to only one realm account. Issuing another challenge invalidates the old pending challenge for that account.

The SQLite TEST journal is append-only and uses exact signed 64-bit integer entries, BigInt arithmetic, immutable operation IDs and immediate transactions. `/state` reports its separate TEST account vault; `/history` returns the most recent 50 entries. Server-only journal spend primitives are tested but no public spending, transfer or client reward endpoint exists. `POST /test-allocation` is the only TEST funding route. Back up the SQLite database consistently including its WAL (use a SQLite backup or stop the web process first); copying a running database file alone is not sufficient.

Optional `getCharacters(req)` must fetch the realm's session-scoped `GET /api/character-balances` using the current request's cookie, a fixed internal URL and a timeout. It must return `{characters:[{guid,name,moneyUnits,online}],snapshot:'last-saved',nonredeemable:true}`; reject any failed/authentication response. `moneyUnits` must be an exact decimal string in the Classic money range. Never let browser query parameters choose an account or character. The panel labels these authoritative balances **In-game TEST currency (last saved)**; online changes can lag until the realm saves them. Missing, failed or invalid adapters report unavailable rather than fabricate a balance.

**Integration limit:** the account TEST vault is not CMaNGOS character money and cannot fund a character. Vendors, trade, loot, mail, auction settlement and character persistence belong to the game server. The optional snapshot is read-only; it does not implement the future token bridge. No kill payout or fabricated game reward is accepted here. The browser never submits a balance or character ownership claim.

**Launch gate:** this module's deposit, withdrawal and swap routes return 503 unconditionally, even if a mint or launch-like flags are supplied. The separate `market/` module prepares guarded, noncustodial SOL/token swaps between a player's wallet assets; that does not redeem game currency. Its launch flags remain off in staging. The separate `settlement/` engine implements durable finalized receipts and withdrawal reservations without exposing them over HTTP. A supplied CA alone does not enable game settlement. Live game settlement still requires an immutable conversion, a funded/reconciled reserve, signer operations, durable world escrow, backed issuance, abuse controls and launch approval. TEST characters, items and balances have no promised conversion or carryover. This module creates no mint, keys or treasury and sends no transactions.

Tests: `node --test deploy/realm/economy/tests/*.test.mjs`. They exercise real SQLite files, real Ed25519 signatures, restart/replay, account isolation, exact amounts, double spending, CSRF and closed launch paths. Read-only RPC tests inject the network response; no chain operation is sent during tests.

API references: [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [Solana token accounts by owner](https://solana.com/docs/rpc/http/gettokenaccountsbyowner).
