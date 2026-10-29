// How often does a landed shortfall (InsufficientFunds / "Not enough tokens") lose its precise figure because the
// replay fails earlier today? Samples recent failed transactions with Custom 1 from the token program or system
// program across the watched programs, asks production, and tallies which verdict title came back.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROGRAMS = ["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"];
const tally = {}; let n = 0;
for (const p of PROGRAMS) {
  const sigs = (await conn.getSignaturesForAddress(new PublicKey(p), { limit: 300 }).catch(() => [])).filter((s) => s.err?.InstructionError && s.err.InstructionError[1]?.Custom === 1).slice(0, 8);
  for (const s of sigs) {
    let r = {};
    try { r = await (await fetch("https://txwhy.vercel.app/api/v1/repair", { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature: s.signature }), signal: AbortSignal.timeout(40000) })).json(); } catch { r = { status: "net" }; }
    const precise = /^(Not enough tokens to transfer|Insufficient SOL|Not enough tokens to sell|Launch pool)/.test(r.cause?.title ?? "");
    const k = `${precise ? "PRECISE" : "generic"} | ${r.status} | ${(r.cause?.title ?? "?").slice(0, 36)} | probe today: ${(r.simulation?.error?.title ?? "-").slice(0, 30)}`;
    tally[k] = tally[k] ?? { n: 0, sig: s.signature }; tally[k].n++; n++;
    await sleep(2300);
  }
}
console.log(`${n} landed Custom-1 failures sampled`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(3), k, "| e.g.", v.sig);
