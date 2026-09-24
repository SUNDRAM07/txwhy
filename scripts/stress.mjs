// Concurrency check: N simultaneous repairs of the same demo transaction against one deployment.
// Reports the status mix and latency spread. Every answer must be 200 (or an honest 429 once the
// per-IP limit is passed), never a 5xx and never slower than the 26 s answer deadline.
//   node scripts/stress.mjs [concurrency=24]           # https://txwhy.vercel.app by default
import { writeFileSync } from "node:fs";

const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const N = Number(process.argv[2] ?? 24);
const headers = { "content-type": "application/json", "x-txwhy-client": "test" };
const example = await (await fetch(`${BASE}/api/v1/example?kind=compute`, { headers })).json();
if (!example.transaction) { console.log("no example transaction:", example); process.exit(1); }

const started = Date.now();
const runs = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const t = Date.now();
    try {
      const res = await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers, body: JSON.stringify({ transaction: example.transaction }), signal: AbortSignal.timeout(40_000) });
      const json = await res.json().catch(() => null);
      return { i, status: res.status, kind: json?.status ?? json?.error ?? "?", ms: Date.now() - t };
    } catch (e) {
      return { i, status: -1, kind: e.name, ms: Date.now() - t };
    }
  }),
);
const wall = Date.now() - started;
const mix = {};
for (const r of runs) mix[`${r.status} ${String(r.kind).slice(0, 24)}`] = (mix[`${r.status} ${String(r.kind).slice(0, 24)}`] ?? 0) + 1;
const times = runs.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))];
console.log(`${N} concurrent repairs in ${wall} ms wall; p50 ${pct(50)} ms, p90 ${pct(90)} ms, max ${times[times.length - 1]} ms`);
for (const [k, v] of Object.entries(mix).sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(3)}  ${k}`);
const bad = runs.filter((r) => r.status >= 500 || r.status < 0 || r.ms > 26_000);
writeFileSync(new URL("./stress-results.json", import.meta.url), JSON.stringify(runs, null, 1));
console.log(bad.length ? `FAIL: ${bad.length} answer(s) were 5xx, errors or over the deadline` : "PASS: no 5xx, no timeouts");
process.exit(bad.length ? 1 : 0);
