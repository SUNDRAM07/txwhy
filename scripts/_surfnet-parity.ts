// Account parity: for each landed transaction, compare every account it touches between mainnet and the surfnet.
// Lamport-only differences on data-less accounts are balance drift since the surfnet fetched them; data differences matter.
// Run: npx tsx scripts/_surfnet-parity.ts
import { createHash } from "node:crypto";
const MAIN = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SURF = process.env.SURFNET_RPC_URL ?? "http://127.0.0.1:8899";
const SIGS: [string, string][] = [
  ["Pump.fun 48QY", "48QY3d2GoR5zhFA6ZCvyxJmcMZQ9KvnTMujUjpC2u4J8gm2yqRnhKynuCiw6Vz9uUVoWxmu85L2eD7hMXdeX1i24"],
  ["PumpSwap dup 3K5d", "3K5d7tgWhHUXE7DXmSutrH4erj5DNHK2F5U2xmuyM9HRdV3uUdQLHxWtgWHQ18xHxGx1wR97HYRh4TMdLiKiMhjt"],
  ["DBC graduated 3jhc", "3jhcCvczVZAfp6rTxWm6gsXsjHNphgVVH5iqYUKZAuCzbXJMaX47JScw2fHrhfKNm3W8vyurZVv97jgDvKbzzHPM"],
];
async function rpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method} on ${url}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (a: any) => (a == null ? "missing" : createHash("sha256").update(Buffer.from(a.data[0], "base64")).digest("hex").slice(0, 12));
async function main() {
  for (const [label, sig] of SIGS) {
    const tx = await rpc(MAIN, "getTransaction", [sig, { maxSupportedTransactionVersion: 1, encoding: "json" }]);
    const keys: string[] = [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
    await sleep(1500);
    const m = await rpc(MAIN, "getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
    const s = await rpc(SURF, "getMultipleAccounts", [keys, { encoding: "base64", commitment: "confirmed" }]);
    let lamportsOnly = 0, dataDiff = 0, missing = 0;
    const lines: string[] = [];
    keys.forEach((k, i) => {
      const a = m.value[i], b = s.value[i];
      if ((a == null) !== (b == null)) { missing++; lines.push(`     ${k}: mainnet ${a ? "present" : "missing"}, surfnet ${b ? "present" : "missing"}`); return; }
      if (a == null) return;
      const ha = hash(a), hb = hash(b);
      if (ha !== hb) { dataDiff++; lines.push(`     ${k} (owner ${a.owner.slice(0, 8)}, ${Buffer.from(a.data[0], "base64").length} bytes): data differs, mainnet ${ha} vs surfnet ${hb}`); return; }
      if (a.lamports !== b.lamports) lamportsOnly++;
    });
    console.log(`${label}: ${keys.length} accounts; data differs on ${dataDiff}, presence differs on ${missing}, lamports-only drift on ${lamportsOnly} (mainnet slot ${m.context.slot}, surfnet slot ${s.context.slot})`);
    for (const l of lines) console.log(l);
    await sleep(1500);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
