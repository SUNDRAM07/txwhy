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

`scripts/test-verify.ts` (29 cases, mostly attacks), `crates/txwhy-verify` (unit + parity with real production repairs + tamper), `scripts/fuzz-repair.mjs` (122 hostile inputs), `scripts/fuzz-mcp.mjs` (52), `scripts/probe-ratelimit.mjs` (forged client IPs).
