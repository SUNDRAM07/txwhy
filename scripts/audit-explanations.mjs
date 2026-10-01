// Reads our explanation for a list of real failed signatures and prints it the way a person sees it,
// so the wording can be judged and fixed. Signatures come from scripts/who-fails.mjs examples.
//   node scripts/audit-explanations.mjs <sig> <sig> ...
const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
for (const sig of process.argv.slice(2)) {
  let r = {};
  for (let a = 0; a < 3; a++) {
    try { r = await (await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature: sig }), signal: AbortSignal.timeout(40_000) })).json(); break; } catch { await new Promise((res) => setTimeout(res, 3000)); }
  }
  console.log(`\n=== ${sig.slice(0, 12)}  status=${r.status}`);
  console.log(`TITLE  ${r.cause?.title}`);
  console.log(`CAUSE  ${(r.cause?.cause ?? "").slice(0, 260)}`);
  console.log(`FIX    ${(r.cause?.fix ?? "").slice(0, 200)}`);
  console.log(`SUMM   ${(r.summary ?? r.error ?? "").slice(0, 160)}`);
  if (r.notes?.length) console.log(`NOTE   ${r.notes[0].slice(0, 160)}`);
  await new Promise((res) => setTimeout(res, 2300));
}
