# Railway and Solana integration

The user requested a GitHub copy, Railway hosting, and currency exchange with SOL and their token after launch. Keep the existing Rust/Bevy survivors client and attribution. The supplied game currently has no spendable currency, shop, persistent rewards, or trusted combat server.

## Implementation choices

- Use the active GitHub account's fork, LamboIsOverrated/azeroth-survivors-re, and a dedicated Railway project.
- Add a separate Node gateway rather than expose the local development host publicly. Serve its existing game-data routes only after a private preview login; disable its unrelated WoW network relay at the gateway.
- Build WASM and the native asset host in a multi-stage Docker image. Keep game data on a Railway volume, excluded from Git and images. The preview may initialize the data using the repository's existing download script, controlled by an explicit deployment variable.
- Add a Phantom/Solflare wallet panel to the existing game page and preview page. Wallet balances come from Solana, never from browser save data.
- Use one future SPL game token and native SOL. Get market quotes and wallet-signed transactions through Jupiter Swap V2; there is no promised fixed SOL exchange rate.
- Default swaps off. Require an explicit launch flag, valid mint, and token decimal configuration before enabling them. Never create or fund a token, liquidity pool, treasury, or signing wallet as part of this deployment.
- The browser signs using its wallet. The server holds no player keys. Bind each submitted transaction to a short-lived order created by the same preview session; reject modified transaction messages.
- XP, health, and unverified run results do not mint or redeem valuable tokens. A server-verified rewards economy remains a prerequisite for cashing out gameplay earnings.

## Approaches

An onchain transaction per pickup adds latency and does not establish that a local kill was legitimate. A database balance redeemable for SOL introduces custody and a treasury promise without an agreed earning model. A wallet-held SPL token with a launch-gated exchange is the narrowest implementation of the user's latest direction; this is the implementer's choice, not a claim that reward rules or launch economics were agreed.

## Verification and limits

Exercise access control, disabled swaps, pair validation, integer precision, transaction substitution, expiry, replay, and proxy failures through the real gateway. Run existing browser tests. Build and smoke-test the Docker deployment on Railway. A health endpoint alone does not prove that game data finished downloading or that combat is playable. A configured exchange still requires a real mint, liquidity, and a user-approved wallet transaction to verify a mainnet swap.
