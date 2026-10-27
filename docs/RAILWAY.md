# Railway private preview

The root Dockerfile builds the existing WASM client, the existing native MPQ data host, and a Node gateway with a Solana wallet panel. It does not embed game data or keys. The native host binds to loopback and the gateway authenticates every game/data request. `/ws/*` is never forwarded. The supplied fan game's runtime data and its source-code licenses are separate; keep this preview restricted to authorized participants.

## Service configuration

Deploy the repository using its Dockerfile. Attach a volume at `/game-data` with sufficient capacity for both the source archive and extracted MPQs (20 GB recommended for initialization). The build is substantial: Rust/Bevy plus the WASM toolchain may take tens of minutes on a cold builder.

- `GAME_ACCESS_CODE`: required, at least 12 characters. Share privately. Changing it invalidates preview sessions.
- `DOWNLOAD_GAME_DATA=true`: opt in to the repository's existing first-run data download. Otherwise supply the user's `Data/` directory under `/game-data/Data` using Railway volume tooling.
- `WOW_DATA_URL`: optional replacement for the existing downloader's archive URL. Keep source URLs out of Git.
- `SOLANA_CLUSTER`: defaults to `mainnet-beta`; `devnet` supports balance previews but never enables mainnet Jupiter exchange.
- `SOLANA_RPC_URL`: optional dedicated Solana RPC URL, held server-side.

`/healthz` confirms that the gateway is running. Its `game` field independently reports `waiting`, `downloading`, `loading`, `ready`, or `error`. A successful gateway deployment does not mean data initialization finished. Open the preview root, enter its access code, and choose **Enter world** once ready. **Wallet** is also available inside the game.

## Token launch

Set these only after the token exists and has a trading route:

- `GAME_TOKEN_MINT`: the actual Solana SPL mint, not a wallet address.
- `GAME_TOKEN_SYMBOL`: the token's display symbol.
- `GAME_TOKEN_DECIMALS`: the mint's actual decimal precision (0–9).
- `TOKEN_LAUNCHED=true` and `SWAPS_ENABLED=true`: both are required.
- `JUPITER_API_KEY`: optional for a keyless-supported Jupiter deployment; recommended for a dedicated quota.

Exchange uses Jupiter Swap V2's order/execute flow and variable market prices. A quoted route is not a guaranteed rate or liquidity promise. The browser wallet signs each explicitly confirmed transaction; the server cannot withdraw or mint on the player's behalf. No token, pool, treasury, private key, deposits, or real-money transactions are created by deployment.

Game-token balances are confirmed chain balances. XP/health are run statistics. This deployment does **not** convert locally reported kills or XP into withdrawable currency. A persistent spend/reward economy requires server-verified gameplay and an agreed funding/emission model before such payouts are enabled.

## Local verification

From `deploy/`, run `npm ci`, `npm run build`, and `npm test`. `npm start` starts the gateway; without data it shows the waiting state. The default local port is 3000. Production uses Railway's `PORT`. Keep credentials in environment variables, never the repository.

The unmodified Rust renderer needs its normal build gates and real game data for a full play test. The deployment tests cover gateway authentication, blocked data/relay access, launch gating, amount precision, wallet/order binding, modified transactions, expiry, replay, and external-service failures.
