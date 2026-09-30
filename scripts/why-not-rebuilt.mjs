// Why do landed slippage failures come back "needs a fresh quote" instead of rebuilt? Pulls fresh failed
// transactions from one program, asks production for the verdict, and tallies the engine's own reasons
// (the notes and summary), so the next engine improvement is chosen from data.
//   node scripts/why-not-rebuilt.mjs [program=JUP6...] [count=24]
import { Connection, PublicKey } from "@solana/web3.js";

const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const PROGRAM = new PublicKey(process.argv[2] ?? "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const COUNT = Number(process.argv[3] ?? 24);
const CODES = new Set((process.env.CODES ?? "6001").split(",").map(Number));
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sigs = await conn.getSignaturesForAddress(PROGRAM, { limit: 400 });
const wanted = sigs.filter((s) => {
  const ie = s.err?.InstructionError;
  return Array.isArray(ie) && ie[1] && typeof ie[1] === "object" && CODES.has(ie[1].Custom);
}).slice(0, COUNT);
console.log(`${sigs.length} recent, ${sigs.filter((s) => s.err).length} failed, ${wanted.length} with code ${[...CODES].join("/")} taken`);

const tally = {};
const examples = {};
for (const s of wanted) {
  let res = null, r = {};
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try {
      res = await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature: s.signature }), signal: AbortSignal.timeout(35_000) });
      r = await res.json().catch(() => ({}));
    } catch { await sleep(3000); }
  }
  if (!res) { tally["network error"] = (tally["network error"] ?? 0) + 1; continue; }
  const reason = (r.status === "repaired" ? "REPAIRED" : `${r.status ?? res.status}: ${(r.notes?.[0] ?? r.summary ?? r.error ?? "").replace(/-?\d[\d.,]*\s?%?/g, "N").replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "…").slice(0, 150)}`);
  tally[reason] = (tally[reason] ?? 0) + 1;
  examples[reason] ??= s.signature;
  await sleep(2300); // stay under the public 30/min limit
}
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}  ${k}\n       e.g. ${examples[k]}`);
