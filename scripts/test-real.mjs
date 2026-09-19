// Pull recent FAILED transactions from mainnet for busy programs and run them through the repair API.
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const API = process.env.API ?? "http://localhost:3111/api/v1/repair";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROGRAMS = { Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Raydium AMM": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Orca Whirlpool": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc" };
const tally = {};
for (const [name, id] of Object.entries(PROGRAMS)) {
  const r = await rpc("getSignaturesForAddress", [id, { limit: 200 }]);
  if (!r.result) { console.log(name, "RPC:", JSON.stringify(r.error)); await sleep(3000); continue; }
  const failed = r.result.filter((s) => s.err).slice(0, 4);
  console.log(`\n=== ${name}: ${failed.length} failed of ${r.result.length} recent ===`);
  for (const s of failed) {
    await sleep(2500);
    const t0 = Date.now();
    const res = await (await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: s.signature }) })).json();
    tally[res.status ?? "error"] = (tally[res.status ?? "error"] ?? 0) + 1;
    console.log(`- ${s.signature.slice(0, 16)}…  onchain=${JSON.stringify(s.err).slice(0, 60)}\n    -> ${res.status ?? "ERROR"} in ${Date.now() - t0}ms | cause: ${res.cause?.title ?? res.error} ${res.cause?.code ? "(" + res.cause.code + ")" : ""}\n    ${(res.notes ?? [])[0]?.slice(0, 150) ?? ""}`);
  }
}
console.log("\nTALLY:", JSON.stringify(tally));
