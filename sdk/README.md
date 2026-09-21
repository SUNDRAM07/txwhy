# txwhy

**Failed Solana transaction in. Working transaction out.**

TxWhy finds the exact reason a transaction fails, rebuilds it, and proves the rebuilt one passes by simulating it against live chain state. This package puts that inside your send loop, and lets you check every repair on your own machine before you sign it.

```bash
npm i txwhy @solana/web3.js
```

## One line in your send loop

```ts
import { sendWithRepair } from "txwhy";

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
import { verifyRepair } from "txwhy";

const check = await verifyRepair(connection, original, repairedBase64);
if (!check.ok) throw new Error(check.violations.join(" ")); // never sign it
```

`verifyRepair` uses your connection only to expand address lookup tables. If you already have decompiled instructions, the core check has no network access and no runtime dependencies at all:

```ts
import { verifyInstructions } from "txwhy/verify";

verifyInstructions({ payer, instructions: before }, { payer, instructions: after });
```

The TxWhy server runs this same function on its own output and refuses to return anything that fails it.

## Just the repair call

```ts
import { repair } from "txwhy";

const result = await repair({ transaction: tx });            // about to send
const result = await repair({ signature: "5Nf…" });          // already failed on chain
// result.status: "repaired" | "valid" | "needs_requote" | "not_repairable"
```

## Command line

```bash
npx txwhy <signature | explorer URL | base64 transaction> [--json]
```

## Also available as

- HTTP: `POST https://txwhy.vercel.app/api/v1/repair`
- MCP server for AI agents: `https://txwhy.vercel.app/api/mcp`
- Telegram: [@txwhy_bot](https://t.me/txwhy_bot)
- Error code reference: https://txwhy.vercel.app/errors

MIT licensed.
