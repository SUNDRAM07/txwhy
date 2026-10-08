// What is in the "other" bucket? Replay recent failures with any error code through production and tally cause titles.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const SKIP = new Set((process.env.SKIP ?? "").split(",").filter(Boolean).map(Number));
for (const prog of process.argv.slice(2)) {
  const sigs = (await get(() => conn.getSignaturesForAddress(new PublicKey(prog), { limit: 1000 }))) ?? [];
  const failed = sigs.filter((s) => s.err && !(s.err.InstructionError && SKIP.has(s.err.InstructionError[1]?.Custom)));
  const step = Math.max(1, Math.floor(failed.length / 14));
  const sample = failed.filter((_, i) => i % step === 0).slice(0, 14);
  const tally = {};
  for (const s of sample) {
    await sleep(2300);
    let r = {};
    try { r = await (await fetch("https://txwhy.vercel.app/api/v1/repair", { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature: s.signature }), signal: AbortSignal.timeout(40000) })).json(); } catch { r = { status: "net" }; }
    const code = s.err.InstructionError ? (typeof s.err.InstructionError[1] === "string" ? s.err.InstructionError[1] : "Custom " + s.err.InstructionError[1].Custom) : JSON.stringify(s.err).slice(0, 30);
    const k = `${r.status} | ${(r.cause?.title ?? "?").slice(0, 40)} | ${code}`;
    tally[k] = tally[k] ?? { n: 0, sig: s.signature, note: (r.notes ?? []).find((x) => /cannot be repaired|Shortfall|No swap found|Re-run today|moved more/.test(x))?.slice(0, 110) ?? "" };
    tally[k].n++;
  }
  console.log(`\n## ${prog.slice(0, 8)}: ${failed.length} failed of ${sigs.length}, sampled ${sample.length}`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1].n - a[1].n)) console.log(String(v.n).padStart(3), k, "\n     ", v.sig.slice(0, 12), v.note);
}
