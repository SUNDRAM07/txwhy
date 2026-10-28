// How does Surfpool's pump-bonding-curve-custom template apply values? One field at a time, string vs number, with and without fetchBeforeUse.
//   SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/_probe-override.ts <pump mint>
import { Connection, PublicKey } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
const SURF = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const conn = new Connection(SURF, "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function rpc(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(SURF, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result;
}
async function read(address: PublicKey) {
  const d = (await conn.getAccountInfo(address))!.data;
  return `vTok ${d.readBigUInt64LE(8)} vSol ${d.readBigUInt64LE(16)} rTok ${d.readBigUInt64LE(24)} rSol ${d.readBigUInt64LE(32)} supply ${d.readBigUInt64LE(40)} complete ${d[48]}`;
}
async function main() {
  const mint = new PublicKey(process.argv[2]);
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
  console.log("live:", await read(curve));
  const tries: [string, Record<string, unknown>, boolean][] = [
    ["complete=true, fetch", { complete: true }, true],
    ["complete=false, fetch", { complete: false }, true],
    ["vSol as number 50000000000, fetch", { virtual_quote_reserves: 50000000000 }, true],
    ["vSol as string 60000000000, fetch", { virtual_quote_reserves: "60000000000" }, true],
    ["vSol as number 70000000000, no fetch", { virtual_quote_reserves: 70000000000 }, false],
  ];
  for (const [label, values, fetch] of tries) {
    const scenario = { id: randomUUID(), name: label, description: label, overrides: [{ id: randomUUID(), templateId: "pump-bonding-curve-custom", values, scenarioRelativeSlot: 1, label, enabled: true, fetchBeforeUse: fetch, account: { pubkey: curve.toBase58() } }], tags: ["probe"] };
    let resp: unknown;
    try { resp = await rpc("surfnet_registerScenario", [scenario]); } catch (e) { console.log(`${label}: ERROR ${(e as Error).message}`); continue; }
    await sleep(1500);
    console.log(`${label}: resp ${JSON.stringify(resp)?.slice(0, 80)} -> ${await read(curve)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
