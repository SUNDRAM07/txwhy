---
name: txwhy
description: Repair a failing Solana transaction before sending it, or diagnose one that failed. Fixes compute limit, expired blockhash, priority fee, loaded-data limit, Jupiter slippage (fresh quote, same trade) and direct Pump.fun/PumpSwap/Raydium AMM v4 slippage (bounded limit move). Returns an unsigned rebuilt transaction with a simulation proof and an offline-verifiable diff. Legacy, v0 and v1 transactions. No API key.
---

# TxWhy: failed transaction in, working transaction out

Use this skill whenever a Solana transaction fails at simulation or on chain, or before sending any transaction an agent built.

## Fastest path (TypeScript)

```ts
import { sendWithRepair } from "@txwhy/sdk"; // npm i @txwhy/sdk @solana/web3.js
const { signature, repairs } = await sendWithRepair(connection, transaction, (tx) => wallet.signTransaction(tx));
```

Simulates on your RPC; if it passes, sends and never contacts TxWhy. If it would fail: repair, verify locally, sign, send. Keys never leave the process.

## Plain HTTP (any language)

```
POST https://txwhy.vercel.app/api/v1/repair
{"transaction": "<base64, signed or unsigned>"}      or   {"signature": "<sig or explorer URL>"}
```

Response fields: `status` (repaired | valid | needs_requote | not_repairable), `cause` {title, code, cause, fix}, `changes` [{type, before, after, reason}], `repairedTransaction` (base64, unsigned), `simulation` {passed, unitsConsumed}, `verification` {ok, kept, changes}, `notes`.

Rate limit 30/min per IP. Paid and unlimited: `POST /api/x402/repair`, $0.001 USDC on Solana via x402, charged only on success.

## MCP

Add `{"mcpServers": {"txwhy": {"url": "https://txwhy.vercel.app/api/mcp"}}}`. Tools: `repair_transaction`, `diagnose_transaction`, `explain_error`.

## Rules to rely on

- A repair only ever changes: compute budget, blockhash, one Jupiter swap replaced by an equivalent one (same wallet, accounts, output token, amount, tolerance), or one Pump.fun/PumpSwap/Raydium AMM v4 limit moved at most 25% against the user. Everything else is byte for byte identical. Verify it yourself with `verifyRepair` from `@txwhy/sdk` (no network needed).
- `needs_requote` means the price moved past a tolerance TxWhy could not honour; get a fresh quote yourself.
- `not_repairable` carries the exact cause and fix (for example insufficient SOL with the shortfall, a private program's own error, a circular arbitrage that cannot succeed).
- Version 1 transactions: use `sendWithRepair` from `@txwhy/sdk/kit` (takes a kit `Transaction` or base64; signs with your kit signer). web3.js 1.x cannot serialize v1.

## Error codes

`https://txwhy.vercel.app/errors/{program-slug}/{code}` covers 1,934 published custom errors (for example /errors/jupiter-aggregator-v6/6001 for 0x1771).
