# Contributing

The most useful contribution is a failed transaction TxWhy explains badly or cannot rebuild. Open an issue with the signature (or the base64 of the unsigned transaction) and what you expected. Signatures are public; never paste a private key or seed phrase anywhere.

## Working on the code

```bash
npm install
npm run dev -- -p 3111
npx tsx scripts/test-verify.ts       # offline verifier suite
npx tsx scripts/test-lighthouse.ts   # offline guard-decoding suite
node scripts/test-repair.mjs         # repair scenarios against the local server
```

Rules that do not bend:

1. A repair may only change ComputeBudget instructions, the blockhash, one equivalent Jupiter swap, or one direct-swap limit by at most 25%. Anything that widens this needs a new verifier rule, tests that attack it, and the same rule in `crates/txwhy-verify`.
2. Every new failure class starts from real transactions: add the signature or the raw instruction bytes to a test, as `scripts/test-lighthouse.ts` does.
3. Nothing about a caller's transaction, address or IP is stored. Counters only.
4. Tests that hit production send `x-txwhy-client: test` so public usage numbers stay honest.

`scripts/why-not-rebuilt.mjs` and `scripts/who-fails.mjs` replay fresh mainnet failures and tally what we do not handle yet. That list is the roadmap.
