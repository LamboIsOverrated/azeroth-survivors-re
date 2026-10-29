# Native SOL economy direction

The user replaced the future custom token with native SOL. Earlier instructions authorize implementation choices and continued building. This supersedes the custom-token and token/SOL-swap direction for the browser MMO; the separate original Survivors preview stays unchanged.

Use the existing Node 24 gateway, Solana library and conserved accounting kernel. Native SOL needs no mint, token account, wrapping or exchange. Keep gameplay off-chain and express prospective backing in exact lamports (9 decimal places). Existing TEST character money and vault allocations remain nonredeemable with no conversion or carryover. No money conversion is chosen implicitly: the game-unit scale must be explicit and immutable for a future backed namespace.

## Approach

Extending the existing conserved accounting kernel preserves its deposit replay protection, complete claim totals, durable reservations, immutable signed bytes and ambiguous-payment recovery. A second independent SOL ledger would duplicate those boundaries. An on-chain payment per combat event would add confirmation latency and still require trustworthy reward authority. Extend the existing kernel, initially for a separately configured devnet SOL namespace, with no public settlement activation or signer provisioning.

Native transfers use exactly one legacy System Program Transfer followed by a bound Memo, with the source wallet as sole signer and fee payer. Verify the actual Ed25519 signature and entire message, exact destination/amount/memo, all pre/post lamport balances, transaction fee, success and finalized status/slot. Reject token transfers, extra instructions, CPI, noncanonical encodings and unsafe numeric RPC amounts. Config pins native asset kind, devnet genesis, 9 decimals, treasury wallet, positive explicit game-unit scale and a reserve floor; old SPL namespaces retain byte-identical configuration semantics.

For this devnet implementation a withdrawal request is a **gross debit** including the network fee. Quote the exact transaction fee before signing; the recipient receives gross minus fee. A successful receipt must prove the exact quoted fee and payout. A finalized failed transaction still consumes its proven fee and returns only the remainder to the player's vault. Expiry with the existing complete absence proof returns the full gross amount. Ambiguous outcomes retain the gross reservation and reuse stored bytes. The independent treasury floor cannot back customer claims. This policy must be displayed before any future public transaction approval.

## Player surface

The realm wallet targets native SOL only and removes custom-token/launch-coin placeholders and swap controls. Chain balance display explicitly identifies its cluster and validates that cluster's genesis before reading SOL; it never implies that wallet SOL backs TEST game money. Default read-only cluster is devnet. Legacy mint/launch flags cannot reopen realm market routes. Authentication, wallet proof, account isolation, CSRF and closed deposit/withdraw routes remain intact.

## Verification and activation boundary

Add failing tests before implementation, including fee conservation on success/failure, replay/restart/ambiguous sends, network mismatch, immutable namespaces, wrong signed messages, stale reserve evidence and TEST separation. Run existing SPL and accounting suites to preserve their semantics, gateway integration tests, wallet build and independent review. Offline RPC fixtures are not an on-chain devnet acceptance run. No existing wallet, signing secret, real funds, token mint, liquidity pool or mainnet transfer is used. Public settlement remains closed pending treasury/signer configuration, funded stock-gameplay integration, operational reconciliation and independent launch review.

Primary references: [Solana transactions](https://solana.com/docs/core/transactions), [finalized transaction RPC](https://solana.com/docs/rpc/http/gettransaction), [network clusters](https://solana.com/docs/references/clusters).
