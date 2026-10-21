// Smoke test: the TxWhy engine with a local Surfpool surfnet as its RPC, each verdict next to the hosted engine's verdict on mainnet at the same moment.
// Run: SOLANA_RPC_URL=http://127.0.0.1:8899 SOLANA_RPC_FALLBACK_URL=https://api.mainnet-beta.solana.com npx tsx scripts/_surfnet-smoke.ts
import { repair } from "../src/lib/repair";

const HOSTED = "https://txwhy.vercel.app";
const landed: [string, string][] = [
  ["Pump.fun, repaired on mainnet (blockhash)", "48QY3d2GoR5zhFA6ZCvyxJmcMZQ9KvnTMujUjpC2u4J8gm2yqRnhKynuCiw6Vz9uUVoWxmu85L2eD7hMXdeX1i24"],
  ["Jupiter, repaired on mainnet (fresh quote)", "5d3MyVXvs52y5PRBEp1n5o3dtbpmSE5yNibH5WTLuvj4W8S5rP5iKgMqpHsg77uCgtWA8hCyrsnp6Ecq8722Hx1Q"],
  ["LaunchLab, shortfall refusal", "46jSVdw2KUGVVnMCEnEcSvTHwoyRmNVYGjxNythN4m8UAfz1ej6RTjC6hLF4vtataqpZeEdAPYibcv5VtDZLHHad"],
  ["PumpSwap, duplicate send refused by rule", "3K5d7tgWhHUXE7DXmSutrH4erj5DNHK2F5U2xmuyM9HRdV3uUdQLHxWtgWHQ18xHxGx1wR97HYRh4TMdLiKiMhjt"],
  ["Meteora DBC, graduated pool", "3jhcCvczVZAfp6rTxWm6gsXsjHNphgVVH5iqYUKZAuCzbXJMaX47JScw2fHrhfKNm3W8vyurZVv97jgDvKbzzHPM"],
];
const line = (r: any) => `${r.status} | ${r.cause?.title ?? "-"} | changes: ${(r.changes ?? []).map((c: any) => c.type).join(",") || "-"} | sim ${r.simulation?.passed ? "pass" : "fail"} | ${String(r.summary ?? "").slice(0, 110)}`;

async function hosted(body: object) {
  const res = await fetch(`${HOSTED}/api/v1/repair`, { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  return res.json();
}

async function main() {
  console.log(`engine RPC: ${process.env.SOLANA_RPC_URL}`);
  for (const [label, signature] of landed) {
    const started = Date.now();
    try {
      const r = await repair({ signature });
      const ms = Date.now() - started;
      const h = await hosted({ signature }).catch((e) => ({ status: `hosted error: ${(e as Error).message.slice(0, 60)}` }));
      console.log(`[landed] ${label}`);
      console.log(`   surfnet: ${line(r)} (${ms} ms)`);
      console.log(`   mainnet: ${line(h)}`);
    } catch (e) {
      console.log(`[landed] ${label}`);
      console.log(`   surfnet: ERROR ${(e as Error).message.slice(0, 160)}`);
    }
  }
  for (const kind of ["blockhash", "compute", "slippage"]) {
    const ex = await (await fetch(`${HOSTED}/api/v1/example?kind=${kind}`, { signal: AbortSignal.timeout(90_000) })).json();
    const transaction: string | undefined = ex.transaction;
    if (!transaction) { console.log(`[pre-send] ${kind}: no transaction in example (${Object.keys(ex).join(",")})`); continue; }
    const started = Date.now();
    try {
      const r = await repair({ transaction });
      const ms = Date.now() - started;
      const h = await hosted({ transaction }).catch((e) => ({ status: `hosted error: ${(e as Error).message.slice(0, 60)}` }));
      console.log(`[pre-send] ${kind}: ${ex.description}`);
      console.log(`   surfnet: ${line(r)} (${ms} ms)`);
      console.log(`   mainnet: ${line(h)}`);
    } catch (e) {
      console.log(`[pre-send] ${kind}`);
      console.log(`   surfnet: ERROR ${(e as Error).message.slice(0, 160)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
