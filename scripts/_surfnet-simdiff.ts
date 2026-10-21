// Simulate the same landed transaction bytes on mainnet and on the surfnet with the engine's simulate flags, and diff the outcome.
// Run: npx tsx scripts/_surfnet-simdiff.ts
const MAIN = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SURF = process.env.SURFNET_RPC_URL ?? "http://127.0.0.1:8899";
const SIGS: [string, string][] = [
  ["Pump.fun 48QY", "48QY3d2GoR5zhFA6ZCvyxJmcMZQ9KvnTMujUjpC2u4J8gm2yqRnhKynuCiw6Vz9uUVoWxmu85L2eD7hMXdeX1i24"],
  ["DBC graduated 3jhc", "3jhcCvczVZAfp6rTxWm6gsXsjHNphgVVH5iqYUKZAuCzbXJMaX47JScw2fHrhfKNm3W8vyurZVv97jgDvKbzzHPM"],
];
async function rpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method} on ${url}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function main() {
  for (const [label, sig] of SIGS) {
    const tx = await rpc(MAIN, "getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "base64" }]);
    const base64: string = tx.transaction[0];
    await sleep(1200);
    const opts = { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true, commitment: "confirmed", encoding: "base64" };
    const m = await rpc(MAIN, "simulateTransaction", [base64, opts]);
    const s = await rpc(SURF, "simulateTransaction", [base64, opts]);
    const pick = (r: any) => ({ err: JSON.stringify(r.value.err), units: r.value.unitsConsumed, logs: (r.value.logs ?? []).filter((l: string) => /Program log|Program data|failed|Error/.test(l)).slice(-8) });
    const a = pick(m), b = pick(s);
    console.log(`${label}`);
    console.log(`   mainnet err ${a.err} units ${a.units}`);
    for (const l of a.logs) console.log(`      ${l.slice(0, 150)}`);
    console.log(`   surfnet err ${b.err} units ${b.units}`);
    for (const l of b.logs) console.log(`      ${l.slice(0, 150)}`);
    await sleep(1200);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
