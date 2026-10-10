// The live figures every submission text quotes, in the words the texts use. Run on submission morning.
//   node scripts/live-numbers.mjs
const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const h = { "x-txwhy-client": "test" };
const index = await (await fetch(`${BASE}/api/v1/index`, { headers: h })).json();
const stats = await (await fetch(`${BASE}/stats`, { headers: h })).text();
const pick = (label) => (stats.match(new RegExp(`${label}</p><p[^>]*>([0-9,.%]+)`)) ?? [])[1] ?? "?";
const npm = await (await fetch("https://api.npmjs.org/downloads/point/last-week/@txwhy/sdk")).json().catch(() => ({}));
const pypi = await (await fetch("https://pypistats.org/api/packages/txwhy/recent")).json().catch(() => ({}));
const r = index.repair ?? {};
const seg = r.segments ?? {};
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const pct = (v, d = 1) => `${(Number(v ?? 0) * 100).toFixed(d)}%`;
const by = Object.fromEntries((index.byProgram ?? []).map((p) => [p.program, p]));
console.log(`Sampled since Sep 21: ${n(index.transactionsSeen)} (${(index.transactionsSeen / 1e6).toFixed(1)} million), ${pct(index.failureRate)} failed`);
console.log(`Spoken: Jupiter ${pct(by.Jupiter?.failureRate, 0)}, Pump.fun ${pct(by["Pump.fun"]?.failureRate, 0)}, Raydium LaunchLab ${pct(by["Raydium LaunchLab"]?.failureRate, 0)}, Meteora DBC ${pct(by["Meteora DBC"]?.failureRate, 0)}`);
console.log(`Replayed: ${n(r.attempted)} attempts, ${n(r.verdicts?.repaired)} rebuilt and verified, ${n(r.verdicts?.engine_error)} engine errors, ${pct(seg.rebuiltShareOfPeople)} of the failures real people hit`);
console.log(`Usage (tests excluded): ${pick("Repair attempts")} repair attempts, ${pick("Unique callers")} distinct callers, ${pick("Diagnoses")} diagnoses`);
console.log(`Downloads: npm ${npm.downloads ?? "?"} last week, PyPI ${pypi.data?.last_week ?? "?"} last week`);
console.log(`History points: ${(index.history ?? []).length}; index updated ${index.updatedAt}`);
