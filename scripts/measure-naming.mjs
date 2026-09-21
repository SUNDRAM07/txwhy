// How many real failed transactions get a NAMED cause? Samples recent failures from busy programs.
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const API = process.env.API ?? "http://localhost:3111/api/v1/repair";
const rpc = async (method, params) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROGRAMS = { Raydium: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", Orca: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "Meteora DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" };
const per = Number(process.env.N ?? 5); let named = 0, total = 0, priv = 0; const unnamed = [];
for (const [label, id] of Object.entries(PROGRAMS)) {
  const r = await rpc("getSignaturesForAddress", [id, { limit: 400 }]);
  const failed = (r.result ?? []).filter((s) => s.err).slice(0, per);
  for (const s of failed) {
    await sleep(2300);
    let res; try { res = await (await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signature: s.signature }) })).json(); } catch { continue; }
    const title = res.cause?.title ?? res.error ?? "?"; total++;
    const isPrivate = /from a private program/.test(title);
    const isNamed = !isPrivate && !/ error \d+ \(0x|^(Unrecognized|\?)/.test(title);
    if (isPrivate) priv++;
    if (isNamed) named++; else if (!isPrivate) unnamed.push(`${label}: ${title} ${JSON.stringify(s.err).slice(0, 50)}`);
    console.log(`${isNamed ? "named  " : isPrivate ? "private" : "UNNAMED"} | ${label.padEnd(13)} | ${res.status ?? "error"} | ${title}`);
  }
  await sleep(1500);
}
console.log(`\nNAMED ${named}/${total} (${total ? Math.round((100 * named) / total) : 0}%)`); if (unnamed.length) console.log("unnamed:\n " + unnamed.join("\n "));
