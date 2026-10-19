# Security

TxWhy never holds keys. It receives unsigned (or already-signed) transaction bytes, returns unsigned bytes, and the caller signs. The rule for what a repair may change is code you can run yourself with no network access: `src/lib/verify.ts`, shipped as `verifyRepair` in `@txwhy/sdk` and as the Rust crate `txwhy-verify`. The server runs the same check on its own output and refuses to return anything that fails it.

## Reporting a vulnerability

If you find a way to make TxWhy return a transaction that passes the verifier but moves value somewhere the original did not, or any other security issue, please open a private report through GitHub: **Security → Report a vulnerability** on this repository. You will get a reply within 48 hours. Please do not open a public issue for it.

Things especially worth reporting:

- a repaired transaction the verifier accepts that changes the recipient, the amount, a signer, or any instruction other than ComputeBudget and the one allowed swap
- a way around the 25% cap on direct-swap limit moves
- input that crashes the service or makes it hang (the fuzz suites in `scripts/` are the baseline)
- a way around the rate limits or the worker's shared-secret endpoints

## What is tested

`scripts/test-verify.ts` (49 cases, mostly attacks), `crates/txwhy-verify` (19 unit tests plus parity with real production repairs and a tamper check), `python/tests` (11, same fixtures), `scripts/fuzz-repair.mjs` (122 hostile inputs), `scripts/fuzz-mcp.mjs` (52), `scripts/fuzz-rpc.mjs` (27 hostile inputs to the browser pass-through), `scripts/stress.mjs` and `scripts/soak.mjs` (concurrency and a steady stream against production), `scripts/probe-ratelimit.mjs` (forged client IPs). CI runs the three verifier suites on every push.

## What the service never has

No signing key of any kind is read by the service: the environment holds an RPC URL, a Redis URL, the Telegram bot token and webhook secret, the worker's shared secret, a stats salt, and the x402 receiving address (an address, not a key). The demo transactions on the site use a public exchange wallet as fee payer, so nobody can sign them. Nothing about a submitted transaction is stored; the worker records only verdicts and reasons, and usage is counted by a salted hash of the caller.

## Findings and fixes

- **2026-10-15, verifier, fixed the same day.** All three verifiers allowed any idempotent associated-token-account creation in front of a re-quoted Jupiter swap, checking only the program and the instruction tag. A dishonest repair service could have inserted creations of token accounts owned by a stranger, each paid for with the user's rent (about 0.002 SOL per account). The creation is now allowed only when the funding payer is the fee payer and the owner of the new account is the swapping wallet; the attack case is in all three suites. Found in an internal review; no evidence it was ever exercised. Shipped as @txwhy/sdk 0.4.1, txwhy-verify 0.1.3, txwhy 0.1.1.
- **2026-10-15, dependencies.** Next.js moved from 16.3.4 to 16.3.8 for the advisory on `next/og` image responses, which the transaction page's open-graph image route uses, and for the cache-poisoning and image-optimisation advisories in the same range. Remaining audit items are transitive to the Solana program SDKs (`bigint-buffer` through `@solana/web3.js` 1.x, `toml`, `stream-json`) and wait on upstream; none is reachable from request input in this service.
- **2026-10-04 to 10-07, external tester.** Four rounds from one builder; the only money-relevant point, a repair riding a route with over 10% price impact, led to the 3% price-impact refusal and the 25% worse-quote cap in both verifiers.
- **2026-09-24, credentials.** A crates.io publish token was pasted into a chat during setup; revoked the same day and replaced.
