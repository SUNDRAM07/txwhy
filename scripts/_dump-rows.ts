// Dumps the ranked "why not" rows from the worker's Redis and re-buckets each with whyNot (title + reason
// text only, since notes are not stored), so the "Other" bucket's composition is visible. Prints no secrets.
// Run with the worker's env:  npx -y @railway/cli run --service txwhy-worker npx tsx scripts/_dump-rows.ts [bucket]
import { createClient } from "redis";
import { whyNot } from "../worker/reason";

const url = process.env.REDIS_URL ?? process.env.KV_URL;
if (!url) throw new Error("no REDIS_URL in env");
const only = process.argv[2];
const client = createClient({ url });
await client.connect();
const buckets: Record<string, { n: number; rows: { m: string; s: number }[] }> = {};
for (const key of ["i:repair:detail:not_repairable", "i:repair:detail:moved_too_far"]) {
  const rows = await client.zRangeWithScores(key, 0, -1, { REV: true });
  for (const { value, score } of rows) {
    const i = value.indexOf(": ");
    const title = i > 0 ? value.slice(0, i) : "";
    const summary = i > 0 ? value.slice(i + 2) : value;
    const b = whyNot({ status: "not_repairable", summary, cause: { title }, notes: [] });
    buckets[b] = buckets[b] ?? { n: 0, rows: [] };
    buckets[b].n += score;
    buckets[b].rows.push({ m: value, s: score });
  }
}
await client.quit();
for (const [b, v] of Object.entries(buckets).sort((a, c) => c[1].n - a[1].n)) {
  console.log(`\n== ${b}: ${v.n} over ${v.rows.length} rows`);
  if (only && b !== only) continue;
  for (const r of v.rows.sort((a, c) => c.s - a.s).slice(0, only ? 40 : 4)) console.log(`  ${r.s}\t${r.m}`);
}
