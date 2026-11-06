// Pump.fun failures with custom code 6017 (QuoteReserveThresholdReached): how common, which instruction, what the logs say.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const sigs = (await get(() => conn.getSignaturesForAddress(PUMP, { limit: 1000 }))) ?? [];
const failed = sigs.filter((s) => s.err);
const codes = {};
for (const s of failed) { const c = s.err.InstructionError?.[1]?.Custom ?? JSON.stringify(s.err.InstructionError?.[1] ?? s.err).slice(0, 24); codes[c] = (codes[c] ?? 0) + 1; }
console.log(`Pump.fun: ${failed.length} failed of ${sigs.length}`);
console.log("codes:", Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([c, n]) => `${c}:${n}`).join("  "));
const hits = failed.filter((s) => s.err.InstructionError?.[1]?.Custom === 6017).slice(0, Number(process.argv[2] ?? 3));
for (const s of hits) {
  await sleep(2500);
  const tx = await get(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
  console.log(`\n=== ${s.signature}`);
  const logs = tx?.meta?.logMessages ?? [];
  const i = logs.findIndex((l) => /6017|QuoteReserve|AnchorError/.test(l));
  console.log(logs.slice(Math.max(0, i - 14), i + 4).join("\n"));
}
