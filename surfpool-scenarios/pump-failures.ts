/**
 * Surfpool failure scenarios for Pump.fun, driven through TxWhy. Each scenario overrides a live bonding curve on a
 * surfnet with Surfpool's built-in "pump-bonding-curve-custom" template, builds a real buy against the curve as it was
 * before the override, and runs the TxWhy engine (pointed at the surfnet) on that buy. The engine's verdict is the test.
 *
 *   surfpool start            (another terminal; the surfnet on :8899 fetches mainnet state on demand)
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/pump-failures.ts <pump mint> [payer]
 *
 * Scenarios (one surfnet state each; the curve is reset between them by re-registering live values):
 *   1. price-jumped: the curve's reserves move as if a large buy landed, so the quote is stale -> expect "repaired", limit moved
 *   2. curve-complete: the curve is marked complete -> expect "Launch curve complete" naming the PumpSwap pool
 *   3. nearly-sold-out: the curve has fewer tokens left than the buy wants -> whatever the engine says is the finding
 */
import { OnlinePumpSdk, PumpSdk, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { randomUUID } from "node:crypto";

const SURF = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const TEMPLATE = "pump-bonding-curve-custom";
const [mintArg, payerArg] = process.argv.slice(2);
if (!mintArg) { console.log("usage: SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/pump-failures.ts <pump mint> [payer]"); process.exit(1); }
const mint = new PublicKey(mintArg);
const payer = new PublicKey(payerArg ?? "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const conn = new Connection(SURF, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(SURF, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

interface Curve { virtual_token_reserves: bigint; virtual_quote_reserves: bigint; real_token_reserves: bigint; real_quote_reserves: bigint; complete: boolean }
async function readCurve(address: PublicKey): Promise<Curve> {
  const info = await conn.getAccountInfo(address);
  if (!info) throw new Error("bonding curve not found on the surfnet");
  const d = info.data;
  return { virtual_token_reserves: d.readBigUInt64LE(8), virtual_quote_reserves: d.readBigUInt64LE(16), real_token_reserves: d.readBigUInt64LE(24), real_quote_reserves: d.readBigUInt64LE(32), complete: d[48] === 1 };
}

// Values must be JSON numbers: the template silently ignores decimal strings (checked Oct 28 on surfpool 1.6.1). Curve fields stay under 2^53.
async function override(address: PublicKey, label: string, values: Record<string, number | boolean>, fetchBeforeUse = false) {
  const scenario = {
    id: randomUUID(),
    name: `txwhy: ${label}`,
    description: `TxWhy failure scenario: ${label}`,
    overrides: [{ id: randomUUID(), templateId: TEMPLATE, values, scenarioRelativeSlot: 1, label, enabled: true, fetchBeforeUse, account: { pubkey: address.toBase58() } }],
    tags: ["txwhy", "failure-scenario"],
  };
  await rpc("surfnet_registerScenario", [scenario]);
  await sleep(1500); // two slots at the default 250 ms, with margin
  const now = await readCurve(address);
  console.log(`  [${label}] curve now: vTok ${now.virtual_token_reserves} vSol ${now.virtual_quote_reserves} rTok ${now.real_token_reserves} rSol ${now.real_quote_reserves} complete ${now.complete}`);
}

async function buildBuy(solLamports: bigint): Promise<string> {
  const online = new OnlinePumpSdk(conn);
  const [state, global, feeConfig, quoteControl, mintInfo] = await Promise.all([online.fetchBuyState(mint, payer), online.fetchGlobal(), online.fetchFeeConfig().catch(() => null), online.fetchQuoteControl().catch(() => null), conn.getAccountInfo(mint)]);
  if (!mintInfo) throw new Error("mint not found");
  const supply = await conn.getTokenSupply(mint);
  const solAmount = new BN(solLamports);
  // Tokens the 0.1 SOL buys at the live price; the instruction then carries that amount with a 1% max-cost tolerance.
  const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: new BN(supply.value.amount), bondingCurve: state.bondingCurve, amount: solAmount, quoteMint: state.quoteMint, quoteControl, creatorFeeBps: state.bondingCurve.creatorFeeBps } as any);
  const sdk = new PumpSdk();
  const instructions = await sdk.buyInstructions({ global, bondingCurveAccountInfo: state.bondingCurveAccountInfo, bondingCurve: state.bondingCurve, associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user: payer, amount, solAmount, slippage: 1, tokenProgram: mintInfo.owner });
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

async function verdict(transaction: string) {
  const { repair } = await import("../src/lib/repair");
  const r = await repair({ transaction });
  return `${r.status} | ${r.cause?.title ?? "-"} | changes ${r.changes.map((c) => c.type).join(",") || "-"} | ${r.summary.slice(0, 160)}`;
}

async function main() {
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
  const live = await readCurve(curve);
  console.log(`curve ${curve.toBase58()} live: vTok ${live.virtual_token_reserves} vSol ${live.virtual_quote_reserves} rTok ${live.real_token_reserves} rSol ${live.real_quote_reserves} complete ${live.complete}`);
  if (live.complete) throw new Error("pick a curve that has not completed");
  const buy = await buildBuy(BigInt(100_000_000)); // 0.1 SOL, 1% tolerance, priced on the live curve
  console.log(`\nbaseline, no override: ${await verdict(buy)}`);

  // 1. price jumped: a 15% move in quote reserves with the constant product kept, so the 1% tolerance is far behind
  const k = live.virtual_token_reserves * live.virtual_quote_reserves;
  const vSol = (live.virtual_quote_reserves * BigInt(115)) / BigInt(100);
  const vTok = k / vSol;
  const dTok = live.virtual_token_reserves - vTok;
  const dSol = vSol - live.virtual_quote_reserves;
  await override(curve, "price jumped 15%", { virtual_quote_reserves: Number(vSol), virtual_token_reserves: Number(vTok), real_quote_reserves: Number(live.real_quote_reserves + dSol), real_token_reserves: Number(live.real_token_reserves - dTok) }, true);
  console.log(`after price jump: ${await verdict(buy)}`);

  // 2. curve complete
  await override(curve, "curve complete", { complete: true, real_token_reserves: 0 });
  console.log(`curve complete: ${await verdict(buy)}`);

  // 3. nearly sold out: back to live reserves but only a sliver of real tokens left
  await override(curve, "nearly sold out", { complete: false, virtual_quote_reserves: Number(live.virtual_quote_reserves), virtual_token_reserves: Number(live.virtual_token_reserves), real_quote_reserves: Number(live.real_quote_reserves), real_token_reserves: 1000000 });
  console.log(`nearly sold out: ${await verdict(buy)}`);

  // restore the live values so the surfnet is clean for the next run
  await override(curve, "restore live", { complete: false, virtual_quote_reserves: Number(live.virtual_quote_reserves), virtual_token_reserves: Number(live.virtual_token_reserves), real_quote_reserves: Number(live.real_quote_reserves), real_token_reserves: Number(live.real_token_reserves) });
}
main().catch((e) => { console.error(e); process.exit(1); });
