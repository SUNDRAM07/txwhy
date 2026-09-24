// How much of Orca Whirlpool's recent failure volume is a DIRECT slippage failure (the caller's own
// swap instruction, repairable by moving the limit) versus a router calling Orca by CPI (only the
// router's own instruction could be repaired). Same question test-pump.ts answered for Pump.fun.
//   node scripts/measure-orca.mjs [signatures=120]
import { Connection, PublicKey } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const conn = new Connection(RPC, "confirmed");
const PROGRAM = new PublicKey(process.env.PROGRAM ?? "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const LIMIT = Number(process.argv[2] ?? 120);
const SLIPPAGE_CODES = new Set((process.env.SLIPPAGE_CODES ?? "6018,6019").split(",").map(Number)); // AmountOutBelowMinimum, AmountInAboveMaximum
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sigs = await conn.getSignaturesForAddress(PROGRAM, { limit: LIMIT });
const failed = sigs.filter((s) => s.err);
const custom = (err) => {
  const ie = err?.InstructionError;
  return Array.isArray(ie) && ie[1] && typeof ie[1] === "object" && "Custom" in ie[1] ? { index: ie[0], code: ie[1].Custom } : null;
};
let slippage = 0, direct = 0, cpi = 0, otherErr = 0, fetchFail = 0;
const outer = new Map();
for (const s of failed) {
  const c = custom(s.err);
  if (!c || !SLIPPAGE_CODES.has(c.code)) { otherErr++; continue; }
  slippage++;
  let tx = null;
  for (let attempt = 0; attempt < 3 && !tx; attempt++) {
    tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
    if (!tx) await sleep(400);
  }
  if (!tx) { fetchFail++; continue; }
  const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
  const ix = tx.transaction.message.compiledInstructions?.[c.index] ?? tx.transaction.message.instructions?.[c.index];
  const programIndex = ix?.programIdIndex;
  const program = programIndex != null && keys[programIndex] ? keys[programIndex].toBase58() : "?";
  if (program === PROGRAM.toBase58()) direct++;
  else { cpi++; outer.set(program, (outer.get(program) ?? 0) + 1); }
  await sleep(120);
}
console.log(`${sigs.length} recent transactions on ${PROGRAM.toBase58().slice(0, 8)}…: ${failed.length} failed`);
console.log(`  slippage (codes ${[...SLIPPAGE_CODES].join("/")}): ${slippage} = ${((slippage / Math.max(failed.length, 1)) * 100).toFixed(0)}% of failures`);
console.log(`    direct (outer instruction is the DEX itself, limit move applies): ${direct}`);
console.log(`    via CPI (outer instruction is a router/bot program): ${cpi}`);
console.log(`    could not fetch: ${fetchFail}`);
console.log(`  other errors: ${otherErr}`);
if (outer.size) console.log("  routers seen:", [...outer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k.slice(0, 8)}…×${v}`).join(", "));
