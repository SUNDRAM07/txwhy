# TxWhy

**Failed transaction in. Working transaction out.**

TxWhy finds the exact reason a Solana transaction failed, rebuilds it, and proves the rebuilt one works by simulating it against live mainnet state. It returns the fix unsigned, so your keys never leave your machine.

- Live: **https://txwhy.vercel.app**
- For agents (MCP): `https://txwhy.vercel.app/api/mcp`
- Telegram: **[@txwhy_bot](https://t.me/txwhy_bot)** (try `/demo`)
- Usage, in the open: https://txwhy.vercel.app/stats

## Why

Somewhere between one in eight and one in two Solana transactions fail on a busy day. Bots and agents fail more than half of what they send, and the priority fee is burned every time. What comes back is a code like `Custom(6001)`.

Explorers and AI explainers tell you what happened. Nothing hands you the transaction that works. That is the gap TxWhy fills, and it matters most inside an automated send loop, where nobody is around to read an explanation.

Most failures never reach the chain. Wallets and agents simulate first, and the transaction dies there. So the core flow is not "paste an old signature". It is:

> Your transaction just failed simulation. Hand it to TxWhy. Get back one that passes, typically in under a second.

## What it fixes

| Failure | What TxWhy does |
|---|---|
| Blockhash expired | Replaces it, after checking the original had really expired |
| Compute budget exceeded | Runs the transaction with the maximum budget, reads what it truly used, sets the limit to that plus 15% |
| Dropped under load | Sets the priority fee from what the network recently charged for the exact accounts written to. Never raises your total fee by more than 0.001 SOL, and falls back to your original fee if the wallet cannot afford more |
| Slippage on a Jupiter swap | Replaces **only** the swap instruction with a freshly quoted one. Tokens, amount, slippage tolerance and every other instruction (memos, fee transfers, tips) stay exactly as written. Shows how the minimum you receive changed |
| Loaded account data limit too small | Lifts a declared limit that is smaller than what the transaction loads |

And what it refuses to fake:

| Failure | What TxWhy says instead |
|---|---|
| Not enough SOL | The exact shortfall in lamports and SOL |
| A program rejected it | The named error, cause and fix from 1,874 bundled errors across 37 programs, plus any IDL the program published on chain |
| A private program rejected it | Which program raised the code, and that only its authors can decode it |
| Circular arbitrage that missed its gap | That it is built to fail this way and there is nothing to repair |

A rebuilt transaction is only ever returned if it passes simulation. TxWhy will not hand back something that would fail again.

## How it works

1. **Diagnose.** Fetch or simulate the transaction, build the full instruction and CPI tree, and find the exact failing call by replaying the runtime's own `invoke` / `success` / `failed` log lines.
2. **Name it.** Decode the error through four layers: the runtime's own errors, the program's on-chain Anchor IDL, bundled error tables for major programs, and the System and Token program enums.
3. **Rebuild.** Decompile the message (resolving address lookup tables), apply the repair that matches the cause, and leave everything else untouched.
4. **Prove.** Simulate the rebuilt transaction with `sigVerify: false` against current state. Return it unsigned only if it passes.

## Use it

### REST

```bash
curl -X POST https://txwhy.vercel.app/api/v1/repair \
  -H "content-type: application/json" \
  -d '{"transaction": "<base64, signed or unsigned>"}'
```

Pass `{"signature": "..."}` instead for a transaction that already landed and failed.

```json
{
  "status": "repaired",
  "summary": "Repaired. 2 changes applied and the rebuilt transaction passes simulation.",
  "cause": { "title": "Compute budget exceeded", "code": "...", "cause": "...", "fix": "..." },
  "changes": [
    { "type": "compute_unit_limit", "before": "100", "after": "518", "reason": "..." }
  ],
  "repairedTransaction": "<base64, unsigned>",
  "simulation": { "passed": true, "unitsConsumed": 450, "error": null, "logsTail": ["..."] },
  "notes": ["..."]
}
```

`status` is one of `repaired`, `valid`, `needs_requote`, `not_repairable`.

### MCP (any agent)

```json
{ "mcpServers": { "txwhy": { "url": "https://txwhy.vercel.app/api/mcp" } } }
```

Tools: `repair_transaction`, `diagnose_transaction`, `explain_error`. Stateless Streamable HTTP. No key, no account.

### Telegram

Message [@txwhy_bot](https://t.me/txwhy_bot) a signature, an explorer link, or a base64 transaction. In groups, use `/why <signature>` or reply to a message containing one with `/why`. `/demo` breaks a real swap and repairs it in the chat.

## Run it locally

```bash
npm install
npm run dev                      # http://localhost:3000
```

Optional environment variables:

| Variable | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Mainnet RPC endpoint. Defaults to the public one, which rate-limits hard |
| `JUPITER_API_BASE`, `JUPITER_API_KEY` | Jupiter swap API for slippage repair |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis for the public usage counters. Without it, counting is a silent no-op |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | The Telegram bot |

## Tests

The tests run against a live server and live mainnet. They build deliberately broken unsigned transactions (simulation needs no keys), so they prove the real thing.

```bash
npm run dev -- -p 3111
node scripts/test-repair.mjs      # 7 repair scenarios, including a swap on a stale quote
node scripts/test-real.mjs        # real failed transactions pulled from mainnet
node scripts/test-slippage.mjs    # real slippage failures
node scripts/measure-naming.mjs   # how many real failures get a named cause
```

## What we learned from real data

- On a 25-transaction mainnet sample, every failure raised by a known program was named. The rest, about half, were raised by private trading programs that publish nothing.
- Of 30 slippage failures that landed on chain, 24 were circular arbitrage. Real users' slippage failures happen at simulation and never land, which is why the unsent-transaction path is the one that matters.
- A full repair, including a fresh Jupiter quote, takes about 0.6 seconds on the hosted service.

## Honest limits

- Version 1 transactions are diagnosed but not yet rebuilt. The standard Solana library cannot decode them yet.
- Slippage repair covers swaps where Jupiter is called at the top level. When the swap runs inside another program, the route cannot be replaced from outside it.
- Simulation proves the transaction executes now. It cannot guarantee inclusion if state changes before it lands.
- Rate limits are per server instance until shared storage is attached.

## Stack

Next.js (App Router) and TypeScript on Vercel, `@solana/web3.js`, Jupiter swap API, `mcp-handler` for the MCP server, Upstash Redis for counters.

## Data attribution

`src/lib/data/program-errors.json` is extracted from the MIT-licensed [solana-idls](https://github.com/tenequm/solana-idls) dataset by tenequm. `src/lib/data/dex-labels.json` is Jupiter's public program label list. See `src/lib/data/ATTRIBUTION.md`.

## Development history

Built for Colosseum's Crypto World's Fair hackathon (Sep 14 to Oct 12, 2026), Solana track.

- **Before the hackathon window (Sep 1 to 2):** the transaction trace, the CPI tree, on-chain IDL decoding and a first error knowledge base. At that point TxWhy only explained failures.
- **Inside the window (from Sep 19):** the entire repair engine, slippage re-quoting, simulation proofs, the bundled error tables, exact failure paths, the MCP server, the Telegram bot, rate limiting, usage counters, link previews and the current site.

## License

MIT
