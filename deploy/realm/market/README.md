# Realm wallet market

This module trades SOL and the configured launch token in a player's verified, linked
Phantom or Solflare wallet. It does not move game currency, fund an account vault, make
TEST units redeemable, or enable deposits or withdrawals. There is no custody or server
wallet signer.

## Integration

```js
import { createMarket } from './market/index.mjs';
const market = createMarket({ identity, resolveWallet, env, fetchImpl });
// In the gateway's authenticated request path:
if (await market(req, res)) return;
```

`identity(req)` must return trusted realm identity `{id, username, isAdmin}` or null.
It may supply a stable `sessionId`; otherwise the order is bound to the incoming Cookie
header. `resolveWallet(id)` must return the server-verified linked public address or
null, never a request field. The module handles only `/api/market/*` and returns false
for unrelated requests.

Build with `node market/build.mjs`. Serve `public/realm-market.bundle.js` as JavaScript
at `/realm-market.bundle.js`, and the adjacent CSS at `/realm-market.bundle.css`.
Put `<section data-realm-market></section>` inside the wallet dialog and import the
bundle after creating that element. It auto-mounts and also exports `mountMarket(root)`.
Dispatch `realm-market:refresh` on the element after linking a wallet; dialog opening
also refreshes. Controls and status messages are scoped to this element.

## Closed until launch

Required configuration:

- `PUBLIC_ORIGIN`: exact HTTPS origin, with no trailing slash or path. HTTP is allowed
  only for localhost development.
- `ECONOMY_TOKEN_MINT`: primary launch contract. `GAME_TOKEN_MINT` is a fallback;
  contradictory nonempty values close the market.
- `TOKEN_LAUNCHED=true` **and** `SWAPS_ENABLED=true`.
- `ECONOMY_SOLANA_RPC_URL` (or fallback `SOLANA_RPC_URL`): fixed trusted HTTPS RPC;
  the default is the public Solana mainnet endpoint.
- Optional `ECONOMY_TOKEN_DECIMALS` / `GAME_TOKEN_DECIMALS`: must agree with the mint.
  Decimals are otherwise read directly from the mint account.
- Optional `ECONOMY_TOKEN_SYMBOL` / `GAME_TOKEN_SYMBOL`, and `JUPITER_API_KEY` for
  the operator's Jupiter production API access and rate limits.

The RPC must report the mainnet genesis and a finalized, initialized 82-byte classic
SPL mint owned by the SPL Token program. Token-2022 extension mints are deliberately
not accepted by this integration. Successful validation is cached for 30 seconds;
failed validation for 5 seconds. An unset contract or either disabled launch flag
makes no RPC or trading requests. A valid mint does not prove liquidity: missing or
unbuildable Jupiter routes fail honestly without presenting an executable quote.

## HTTP contract

All endpoints require realm authentication. All POSTs require the exact configured
Origin, JSON content type, and `x-realm-market: 1`. Cross-site requests are rejected.

- `GET /api/market/config`: `{enabled, reason, tokenMint, tokenSymbol, tokenDecimals,
  cluster, wallet, settlementEnabled:false}`.
- `POST /api/market/order`: `{direction:'sol-to-token'|'token-to-sol', amount:'123'}`.
  Amount is a positive integer base-unit string within u64, never a JavaScript number.
  Response includes a local `orderId`, exact base64 transaction, `inAmount`,
  `outAmount`, fixed pair, fee metadata, and `expiresAt` in milliseconds.
- `POST /api/market/execute`: `{orderId, signedTransaction}`. Exact message bytes,
  session/account, current bound wallet, pair, input amount and expiry are bound to
  the issued order. The wallet must be the transaction fee payer and produce a valid
  Ed25519 signature. The transaction is reserved before the upstream submission.
- `POST /api/market/execute`: `{orderId}` checks an existing submitted transaction
  using `getSignatureStatuses` without resubmitting it. It returns `NotSubmitted`
  if no submission was made. `Pending` uses HTTP 202; `Success` and `Failed` use 200.

Quotes last at most 60 seconds, shortened by RFQ expiry, and their block height is
checked before submission when supplied. Browser quoting never opens a signature
prompt. Review and explicit **Sign and submit swap** are separate actions. Exact
decimal parsing uses integers throughout; it never rounds.

Any transport error or ambiguous Jupiter execute result remains **Pending**. A second
execute request cannot send the order again. Pending checks reconcile confirmed or
finalized chain outcomes; a missing signature is not labelled a failed transaction.
The browser retains only a pending order ID/signature in session storage so a reload
continues to block accidental replacement swaps. Always inspect the supplied explorer
link before trading again if the status cannot be resolved.

Order records are process-local, bounded, and retained up to one day. A gateway restart
loses those records: old order IDs fail closed and the explorer signature remains the
recovery reference. Run a single gateway instance or use sticky routing for live
quotes; a distributed/durable order store is required before horizontally scaling.

## Verification

Run `node --test market/tests/*.test.mjs` with Node 24, and the complete realm test
command after integration. Fixtures are deterministic, memory-only signing keys and
mocked RPC/Jupiter responses; tests never fund wallets or send real transactions.

Jupiter primary references verified for this implementation:
[Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute),
[Get Order](https://developers.jup.ag/docs/api-reference/swap/order).
Requests use `https://api.jup.ag/swap/v2/order` and `/execute`, with
`maxSupportedTransactionVersion=0` for the installed web3.js 1.x and injected wallets.
