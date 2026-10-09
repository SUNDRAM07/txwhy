// Which recent failures make the production API answer with something other than a verdict? Print status, time, body head.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = [["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", 7], ["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", 6001]];
for (const [prog, code] of targets) {
  let sigs = [];
  for (let i = 0; i < 5 && !sigs.length; i++) sigs = await conn.getSignaturesForAddress(new PublicKey(prog), { limit: 1000 }).catch(async () => (await sleep(4000), []));
  const wanted = sigs.filter((s) => s.err?.InstructionError?.[1]?.Custom === code).slice(0, 6);
  console.log(`\n## ${prog.slice(0, 8)} code ${code}: ${wanted.length} taken`);
  for (const s of wanted) {
    await sleep(1500);
    const t0 = Date.now();
    const res = await fetch("https://txwhy.vercel.app/api/v1/repair", { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature: s.signature }) }).catch((e) => ({ status: "ERR " + e.message, text: async () => "" }));
    const body = await res.text();
    let j = null; try { j = JSON.parse(body); } catch {}
    console.log(`${s.signature} -> HTTP ${res.status} in ${Date.now() - t0} ms | ${j ? `${j.status} | ${j.cause?.title ?? j.error ?? "?"}` : body.slice(0, 120)}`);
  }
}
