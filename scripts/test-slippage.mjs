// Pull recent Jupiter transactions that failed on slippage (Custom 6001) and run them through the repair API.
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const API = process.env.API ?? "http://localhost:3111/api/v1/repair";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = Number(process.env.N ?? 10);
let before, picked = [];
for (let page = 0; page < 4 && picked.length < want; page++) {
  const r = await rpc("getSignaturesForAddress", ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", { limit: 1000, ...(before ? { before } : {}) }]);
  const list = r.result ?? []; if (!list.length) break; before = list.at(-1).signature;
  picked.push(...list.filter((s) => JSON.stringify(s.err ?? "").includes("6001")));
  await sleep(1500);
}
picked = picked.slice(0, want);
console.log(`slippage failures sampled: ${picked.length}`);
const tally = {};
for (const s of picked) {
  await sleep(2500);
  const t0 = Date.now();
  let res; try { res = await (await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: s.signature }) })).json(); } catch (e) { res = { error: e.message }; }
  const key = res.status ?? "error"; tally[key] = (tally[key] ?? 0) + 1;
  console.log(`\n- ${s.signature.slice(0, 18)}…  -> ${key} (${Date.now() - t0}ms) sim=${res.simulation?.passed} units=${res.simulation?.unitsConsumed}`);
  for (const c of res.changes ?? []) console.log(`    ${c.type}: ${c.before}\n      => ${c.after}`);
  for (const n of (res.notes ?? []).slice(0, 3)) console.log(`    note: ${n.slice(0, 190)}`);
  if (res.error) console.log("    error:", res.error);
}
console.log("\nTALLY:", JSON.stringify(tally));
