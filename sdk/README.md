# txwhy

**Failed Solana transaction in. Working transaction out.**

TxWhy finds the exact reason a transaction fails, rebuilds it, and proves the rebuilt one passes by simulating it against live chain state. This package puts that inside your send loop, and lets you check every repair on your own machine before you sign it.

```bash
npm i @txwhy/sdk @solana/web3.js
```

## One line in your send loop

```ts
import { sendWithRepair } from "@txwhy/sdk";

const { signature, repairs } = await sendWithRepair(connection, transaction, (tx) => wallet.signTransaction(tx));
```

What happens:

1. The transaction is simulated through **your** RPC. If it passes, it is signed and sent. TxWhy is never contacted.
2. If it would fail, the unsigned bytes go to TxWhy, which returns a rebuilt transaction and the reason it failed.
3. The rebuilt transaction is **verified locally** (see below). If anything other than the allowed changes was touched, it is refused and never reaches your signer.
4. Your `sign` callback signs it and it is sent.

Your keys never leave your process. TxWhy only sees, and only returns, unsigned bytes.

With a keypair (bots, agents):

```ts
await sendWithRepair(connection, tx, (t) => { t.sign([keypair]); return t; });
```

### What it repairs

| Failure | Repair |
| --- | --- |
| Compute budget exceeded | Limit resized to measured usage plus 15% |
| Blockhash expired | Fresh blockhash |
| Priority fee too low to land | Raised to the 75th percentile for those accounts, capped at 0.001 SOL total |
| Loaded account data limit exceeded | Limit lifted |
| Jupiter swap failed on slippage | Only the swap instruction is replaced with a current quote for the same tokens, amount and tolerance. Your tolerance is never widened |

Anything else comes back as a diagnosis: the failing instruction, the program that raised the error, the decoded error name and what to do about it. `sendWithRepair` then throws a `TxWhyError` whose `.result.cause` carries that diagnosis.

### Options

```ts
await sendWithRepair(connection, tx, sign, {
  maxRepairs: 1,          // rebuild attempts before giving up
  verify: true,           // local verification before signing (leave it on)
  onRepair: (result, verification) => log(result.changes), // throw here to veto a repair
  sendOptions: { maxRetries: 3 },
  endpoint: "https://txwhy.vercel.app/api/v1/repair",      // or your self-hosted instance
});
```

## You never have to trust us

A service that hands you a transaction to sign could hand you anything. So the rule for what a repair may change is code you run yourself:

- same fee payer, same set of signers
- every instruction that is not Compute Budget is byte for byte identical, in the same order
- at most one Jupiter swap may be replaced, and only by a swap for the same wallet, same source and receiving token accounts, same output token, same amount, same slippage tolerance

```ts
import { verifyRepair } from "@txwhy/sdk";

const check = await verifyRepair(connection, original, repairedBase64);
if (!check.ok) throw new Error(check.violations.join(" ")); // never sign it
```

`verifyRepair` uses your connection only to expand address lookup tables. If you already have decompiled instructions, the core check has no network access and no runtime dependencies at all:

```ts
import { verifyInstructions } from "@txwhy/sdk/verify";

verifyInstructions({ payer, instructions: before }, { payer, instructions: after });
```

The TxWhy server runs this same function on its own output and refuses to return anything that fails it.

## Version 1 transactions

TxWhy repairs the new v1 format (SIMD-0385, mainnet since Sep 15, 2026). web3.js 1.x can read v1 but cannot serialize, sign or send it, so for v1 use the string forms: `repair({ transaction: base64 })` returns rebuilt v1 bytes, `verifyRepair(connection, originalBase64, repairedBase64)` checks that only the header (compute settings) and, at most, one equivalent swap changed, and you sign and send the bytes with `@solana/kit`. `sendWithRepair` refuses v1 with a clear error rather than failing inside web3.js.

## Just the repair call

```ts
import { repair } from "@txwhy/sdk";

const result = await repair({ transaction: tx });            // about to send
const result = await repair({ signature: "5Nf…" });          // already failed on chain
// result.status: "repaired" | "valid" | "needs_requote" | "not_repairable"
```

## Pay per repair, no account (x402)

The free endpoint is rate limited. `POST /api/x402/repair` is the same repair with no limit, paid per call in USDC on Solana over [x402](https://x402.org): $0.001 a repair, settled only after a successful answer, the facilitator pays the network fee. Same `repair()` call, a paying `fetch`:

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";

const paying = wrapFetchWithPayment(fetch, new x402Client().register("solana:*", new ExactSvmScheme(signer)));
const result = await repair({ transaction: tx }, { endpoint: "https://txwhy.vercel.app/api/x402/repair", fetch: paying });
```

Full example: `examples/paid-repair.mjs`. If you self-host: the receiving wallet must already hold a USDC token account (send it any USDC once), or every payment fails simulation at the facilitator.

## Command line

```bash
npx @txwhy/sdk <signature | explorer URL | base64 transaction> [--json]
```

## Also available as

- HTTP: `POST https://txwhy.vercel.app/api/v1/repair`
- MCP server for AI agents: `https://txwhy.vercel.app/api/mcp`
- Telegram: [@txwhy_bot](https://t.me/txwhy_bot)
- Error code reference: https://txwhy.vercel.app/errors

MIT licensed.
