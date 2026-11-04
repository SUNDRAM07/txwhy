/**
 * Surfpool failure scenarios for Meteora Dynamic Bonding Curve pools, driven through TxWhy. Surfpool has no DBC
 * override template yet (meteora-dbc/overrides.yaml in this folder is the proposed one), so each scenario writes the
 * same fields the template would write, through surfnet_setAccount on the pool's bytes, at the offsets the IDL gives.
 * A real buy is built against the pool as it was, and the TxWhy engine (pointed at the surfnet) is asked what it makes
 * of that buy now. The engine's verdict is the test.
 *
 *   surfpool start            (another terminal)
 *   SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/dbc-failures.ts <pool address> [payer]
 *
 * Scenarios (the pool's live bytes are restored at the end):
 *   1. graduated:    quote_reserve = config.migration_quote_threshold        -> PoolIsCompleted
 *   2. nearly full:  quote_reserve = threshold - (a tenth of the buy)         -> a buy bigger than the room left
 *   3. stale quote:  sqrt_price up as if the price rose 15%                   -> ExceededSlippage, repairable or not
 */
import BN from "bn.js";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { CONFIG, POOL, fmtSol, readU128, readU64, viewPool, writeU128, writeU64 } from "./dbc-layout";

const SURF = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const [poolArg, payerArg] = process.argv.slice(2);
if (!poolArg) { console.log("usage: SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/dbc-failures.ts <pool address> [payer]"); process.exit(1); }
const pool = new PublicKey(poolArg);
const payer = new PublicKey(payerArg ?? "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
const conn = new Connection(SURF, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUY = BigInt(50_000_000); // 0.05 SOL

async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(SURF, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}

async function poolBytes(): Promise<Buffer> {
  const info = await conn.getAccountInfo(pool);
  if (!info) throw new Error("pool not found on the surfnet");
  return Buffer.from(info.data);
}

async function setPool(label: string, data: Buffer) {
  await rpc("surfnet_setAccount", [pool.toBase58(), { data: data.toString("hex") }]);
  await sleep(600);
  const v = viewPool(await poolBytes());
  console.log(`  [${label}] pool now: raised ${fmtSol(v.quoteReserve)}, base ${v.baseReserve}, sqrtPrice ${v.sqrtPrice}, migrated ${v.isMigrated}, progress ${v.migrationProgress}`);
}

async function buildBuy(): Promise<string> {
  const sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const client = new sdk.DynamicBondingCurveClient(conn, "confirmed");
  const state = await client.state.getPool(pool);
  if (!state) throw new Error("SDK could not read the pool");
  const poolState = (state as any).poolState ?? state;
  const config = await client.state.getPoolConfig(poolState.config);
  if (!config) throw new Error("SDK could not read the pool config");
  // activation_type 0 counts slots, 1 counts seconds; the quote needs "now" in the same unit
  const currentPoint = new BN(config.activationType === 0 ? await conn.getSlot() : Math.floor(Date.now() / 1000));
  const quote = client.pool.swapQuote({ virtualPool: { poolState }, config, swapBaseForQuote: false, amountIn: new BN(BUY.toString()), slippageBps: 100, hasReferral: false, currentPoint, eligibleForFirstSwapWithMinFee: false } as any);
  const minOut: BN = quote.minimumAmountOut;
  const tx = await client.pool.swap({ owner: payer, pool, amountIn: new BN(BUY.toString()), minimumAmountOut: minOut, swapBaseForQuote: false, referralTokenAccount: null, payer } as any);
  const { blockhash } = await conn.getLatestBlockhash();
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: tx.instructions }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

async function verdict(transaction: string) {
  const { repair } = await import("../src/lib/repair");
  const r = await repair({ transaction });
  return `${r.status} | ${r.cause?.title ?? "-"} | changes ${r.changes.map((c) => c.type).join(",") || "-"} | ${r.summary.slice(0, 220)}`;
}

function sqrtScale(x: bigint, numerator: number, denominator: number): bigint {
  // x * sqrt(numerator/denominator) with integer arithmetic good to 1e-9
  const SCALE = BigInt(1_000_000_000);
  const factor = BigInt(Math.round(Math.sqrt(numerator / denominator) * 1e9));
  return (x * factor) / SCALE;
}

async function main() {
  const live = await poolBytes();
  const v = viewPool(live);
  const cfg = await conn.getAccountInfo(v.config);
  if (!cfg) throw new Error("config not found");
  const threshold = readU64(Buffer.from(cfg.data), CONFIG.migration_quote_threshold);
  const endSqrtPrice = readU128(Buffer.from(cfg.data), CONFIG.migration_sqrt_price);
  console.log(`pool ${pool.toBase58()} live: raised ${fmtSol(v.quoteReserve)} of ${fmtSol(threshold)} (room ${fmtSol(threshold - v.quoteReserve)}), base ${v.baseReserve}, sqrtPrice ${v.sqrtPrice}, migrated ${v.isMigrated}, progress ${v.migrationProgress}`);
  if (v.quoteReserve >= threshold) throw new Error("pick a pool that has not graduated");

  const buy = await buildBuy();
  console.log(`\nbaseline, no override: ${await verdict(buy)}`);

  // 1. graduated: the quote raised reaches the threshold
  const g = Buffer.from(live); writeU64(g, POOL.quote_reserve, threshold);
  await setPool("graduated", g);
  console.log(`graduated: ${await verdict(buy)}`);

  // 2. nearly full: the swap math walks the curve by sqrt_price (quote_reserve is bookkeeping), so the price must sit
  //    just under the config's migration_sqrt_price for a buy to run out of curve; the quote raised follows, just under
  //    the threshold. (Measured Nov 4: quote_reserve alone near the threshold leaves the 0.05 SOL buy valid.)
  const n = Buffer.from(live);
  writeU128(n, POOL.sqrt_price, endSqrtPrice - (endSqrtPrice - v.sqrtPrice) / BigInt(1000));
  writeU64(n, POOL.quote_reserve, threshold - BUY / BigInt(10));
  await setPool("nearly full", n);
  console.log(`nearly full: ${await verdict(buy)}`);

  // 3. stale quote: price up 15% (sqrt price up by sqrt(1.15)); the quote raised moves up too but stays well under the
  //    threshold, or the pool reads as graduated instead
  //    The price must also stay under the curve's end (migration_sqrt_price), or the buy runs out of curve instead:
  //    a pool 90% of the way to graduation has less than 15% of price left, so take at most half the distance.
  const s = Buffer.from(live);
  const jumped = sqrtScale(v.sqrtPrice, 115, 100);
  const halfway = v.sqrtPrice + (endSqrtPrice - v.sqrtPrice) / BigInt(2);
  writeU128(s, POOL.sqrt_price, jumped < halfway ? jumped : halfway);
  const raised = v.quoteReserve + (v.quoteReserve * BigInt(15)) / BigInt(100);
  writeU64(s, POOL.quote_reserve, raised < threshold - BUY * BigInt(4) ? raised : threshold - BUY * BigInt(4));
  await setPool("price up 15%", s);
  console.log(`stale quote: ${await verdict(buy)}`);

  await setPool("restore live", live);
}
main().catch((e) => { console.error(e); process.exit(1); });
