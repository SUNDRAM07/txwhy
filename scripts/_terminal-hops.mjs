// Terminal (ex-Padre, term9YPb…ZzN3): what leads to HopProducedNoOutput (6027)? Prints the log path of a few cases.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const T = new PublicKey("term9YPb9mzAsABaqN71A4xdbxHmpBNZavpBiQKZzN3");
const sigs = (await get(() => conn.getSignaturesForAddress(T, { limit: 1000 }))) ?? [];
const hits = sigs.filter((s) => s.err?.InstructionError?.[1]?.Custom === 6027);
console.log(`${hits.length} HopProducedNoOutput in the last ${sigs.length} Terminal signatures`);
const shapes = {};
for (const s of hits.slice(0, Number(process.argv[2] ?? 8))) {
  await sleep(1700);
  const tx = await get(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
  const logs = tx?.meta?.logMessages ?? [];
  // the call path: program invocations and instruction names, without the noise
  const path = logs.filter((l) => /invoke \[|Instruction: |AnchorError|failed|Program log: (?!Instruction)/.test(l)).map((l) => l.replace(/^Program /, "").replace(/([1-9A-HJ-NP-Za-km-z]{6})[1-9A-HJ-NP-Za-km-z]{26,38}/g, "$1…").replace(/consumed.*/, "").slice(0, 150));
  const key = path.filter((l) => /invoke|Instruction/.test(l)).slice(0, 12).join(" > ");
  shapes[key] = shapes[key] ?? { n: 0, sig: s.signature, path };
  shapes[key].n++;
}
for (const v of Object.values(shapes).sort((a, b) => b.n - a.n)) console.log(`\n=== x${v.n}  ${v.sig}\n${v.path.slice(-22).join("\n")}`);
