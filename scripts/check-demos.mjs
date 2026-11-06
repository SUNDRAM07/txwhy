// Do the homepage demos still end in a repair? Builds each demo transaction through /api/v1/example and
// sends it to /api/v1/repair, the way the "Try it" buttons do. Run it after every deploy and every morning:
// on October 30, 2026 the demo wallet's USDC account was frozen by the mint's freeze authority, and two demos
// answered "AccountFrozen" for a week before anyone looked.
//
//   node scripts/check-demos.mjs                         (production)
//   node scripts/check-demos.mjs http://localhost:3111   (a local server)
const base = process.argv[2] ?? "https://txwhy.vercel.app";
const H = { "content-type": "application/json", "x-txwhy-client": "test" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The price-impact demo is a refusal by design and needs a thin trending token to exist, so it may have no example.
const EXPECT = { compute: "repaired", blockhash: "repaired", v1: "repaired", pump: "repaired", raydium: "repaired", slippage: "repaired", impact: "refused" };

let bad = 0;
for (const [kind, want] of Object.entries(EXPECT)) {
  let line = "";
  let ok = false;
  // Swap demos ride on live prices; one retry separates a market wobble from a broken demo.
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    if (attempt) await sleep(6000);
    try {
      const ex = await (await fetch(`${base}/api/v1/example?kind=${kind}`, { headers: H })).json();
      if (!ex.transaction) {
        ok = want === "refused";
        line = `no example: ${String(ex.error ?? "").slice(0, 110)}`;
        continue;
      }
      const r = await (await fetch(`${base}/api/v1/repair`, { method: "POST", headers: H, body: JSON.stringify({ transaction: ex.transaction }) })).json();
      ok = want === "refused" ? r.status !== "repaired" && r.status !== "valid" : r.status === "repaired" && r.verification?.ok === true && r.simulation?.passed === true;
      line = `${r.status} | ${r.cause?.title ?? "-"} | ${(r.changes ?? []).map((c) => c.type).join(",") || "-"}`;
    } catch (e) {
      line = `error: ${e instanceof Error ? e.message : e}`;
    }
  }
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${kind.padEnd(10)} ${line}`);
  await sleep(5500); // the example route allows 12 calls a minute
}
console.log(bad ? `\n${bad} demo(s) broken on ${base}` : `\nall demos healthy on ${base}`);
process.exit(bad ? 1 : 0);
