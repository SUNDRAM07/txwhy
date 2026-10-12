// Which landed failures still get the generic "cannot be fixed by rebuilding" summary, and what the
// engine knows about them. Samples fresh failures with the given custom codes from busy programs and
// prints production's summary and cause for each.   node scripts/_generic-rows.mjs
import { Connection, PublicKey } from "@solana/web3.js";

const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROGRAMS = {
  Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  PumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  LaunchLab: "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj",
  "Meteora DBC": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  "Meteora DAMM v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
};
const CODES = new Set([3005, 100, 6024, 6023, 3012, 2003, 6000, 1]);
const PER_CODE = 2;

const found = new Map(); // code -> [{program, signature}]
for (const [name, id] of Object.entries(PROGRAMS)) {
  let sigs = [];
  for (let i = 0; i < 4 && !sigs.length; i++) sigs = await conn.getSignaturesForAddress(new PublicKey(id), { limit: 1000 }).catch(async () => (await sleep(3000), []));
  const failed = sigs.filter((s) => s.err);
  const byCode = {};
  for (const s of failed) {
    const ie = s.err?.InstructionError;
    const code = Array.isArray(ie) && ie[1] && typeof ie[1] === "object" ? ie[1].Custom : (typeof ie?.[1] === "string" ? ie[1] : null);
    if (code == null) continue;
    byCode[code] = (byCode[code] ?? 0) + 1;
    if (CODES.has(code) && (found.get(code)?.length ?? 0) < PER_CODE) found.set(code, [...(found.get(code) ?? []), { program: name, signature: s.signature }]);
  }
  const top = Object.entries(byCode).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c}:${n}`).join(" ");
  console.log(`${name}: ${sigs.length} recent, ${failed.length} failed; codes ${top}`);
  await sleep(1200);
}

for (const [code, items] of found) {
  for (const { program, signature } of items) {
    let r = {};
    try {
      const res = await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature }), signal: AbortSignal.timeout(40_000) });
      r = await res.json();
    } catch (e) { r = { error: String(e) }; }
    console.log(`\n[${program} code ${code}] ${signature}`);
    console.log(`  status: ${r.status}  cause: ${r.cause?.title ?? "-"} | ${r.cause?.code ?? ""}`);
    console.log(`  summary: ${(r.summary ?? r.error ?? "").slice(0, 220)}`);
    console.log(`  cause text: ${(r.cause?.cause ?? "-").slice(0, 220)}`);
    console.log(`  notes: ${(r.notes ?? []).map((n) => n.slice(0, 160)).join(" | ")}`);
    await sleep(2300);
  }
}
