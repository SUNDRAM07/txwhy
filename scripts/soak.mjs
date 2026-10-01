// Soak test: a steady stream of mixed real work against one deployment for N minutes, under the public
// rate limit, recording latency per minute and every non-200. Catches drift (latency creeping up,
// upstream RPC trouble, memory leaks showing as slowdowns) that a 2-second burst cannot.
//   node scripts/soak.mjs [minutes=10]            # https://txwhy.vercel.app
import { writeFileSync } from "node:fs";

const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const MINUTES = Number(process.argv[2] ?? 10);
const PER_MINUTE = 24; // public limit is 30/min/IP
const headers = { "content-type": "application/json", "x-txwhy-client": "test" };
const kinds = ["compute", "blockhash", "slippage", "pump", "raydium", "v1"];

const examples = {};
for (const k of kinds) {
  const ex = await (await fetch(`${BASE}/api/v1/example?kind=${k}`, { headers })).json().catch(() => ({}));
  if (ex.transaction) examples[k] = ex.transaction;
}
console.log(`examples ready: ${Object.keys(examples).join(", ")} | ${MINUTES} min at ${PER_MINUTE}/min`);

const rows = [];
const started = Date.now();
let i = 0;
while (Date.now() - started < MINUTES * 60_000) {
  const kind = Object.keys(examples)[i % Object.keys(examples).length];
  const t = Date.now();
  let status = 0, verdict = "";
  try {
    // Demo transactions carry a blockhash from when they were built; refresh every 5 minutes so expiry is not what we measure.
    if (i % (PER_MINUTE * 5) === 0 && i > 0) for (const k of Object.keys(examples)) { const ex = await (await fetch(`${BASE}/api/v1/example?kind=${k}`, { headers })).json().catch(() => ({})); if (ex.transaction) examples[k] = ex.transaction; }
    const res = await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers, body: JSON.stringify({ transaction: examples[kind] }), signal: AbortSignal.timeout(40_000) });
    status = res.status;
    const j = await res.json().catch(() => null);
    verdict = j?.status ?? j?.error ?? "?";
  } catch (e) { status = -1; verdict = e.name; }
  rows.push({ at: Date.now() - started, kind, status, verdict, ms: Date.now() - t });
  i++;
  await new Promise((r) => setTimeout(r, Math.max(0, 60_000 / PER_MINUTE - (Date.now() - t))));
}

const byMinute = {};
for (const r of rows) { const m = Math.floor(r.at / 60_000); (byMinute[m] ??= []).push(r); }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
console.log("min  n   p50    p90    max   non-200  verdicts");
for (const [m, rs] of Object.entries(byMinute)) {
  const ms = rs.map((r) => r.ms);
  const bad = rs.filter((r) => r.status !== 200).length;
  const v = {}; for (const r of rs) v[r.verdict] = (v[r.verdict] ?? 0) + 1;
  console.log(`${String(m).padStart(3)} ${String(rs.length).padStart(3)} ${String(pct(ms, 0.5)).padStart(6)} ${String(pct(ms, 0.9)).padStart(6)} ${String(Math.max(...ms)).padStart(6)}   ${String(bad).padStart(3)}     ${JSON.stringify(v)}`);
}
const bad = rows.filter((r) => r.status !== 200 && r.status !== 429);
const slow = rows.filter((r) => r.ms > 26_000);
console.log(`\n${rows.length} requests; ${bad.length} non-200 (excluding 429), ${slow.length} over the 26 s deadline`);
bad.slice(0, 10).forEach((r) => console.log("  bad:", r));
writeFileSync(new URL("./soak-results.json", import.meta.url), JSON.stringify(rows));
process.exit(bad.length || slow.length ? 1 : 0);
