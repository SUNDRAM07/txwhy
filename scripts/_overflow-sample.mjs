// What is behind the "Overflow" row? Samples recent failures on Pump.fun and PumpSwap whose error is their
// Overflow code (6024 / 6023), prints the instruction, the log path and the amounts, and groups by shape.
//   node scripts/_overflow-sample.mjs [perProgram]
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const TARGETS = {
  "Pump.fun": ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", 6024],
  PumpSwap: ["pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", 6023],
  "Meteora DBC": ["dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", 6000],
  "Meteora DAMM v2": ["cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", 6000],
  "Raydium LaunchLab": ["LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", 6008],
};
const PER = Number(process.argv[2] ?? 12);
for (const [label, [id, code]] of Object.entries(TARGETS)) {
  const sigs = (await get(() => conn.getSignaturesForAddress(new PublicKey(id), { limit: 1000 }))) ?? [];
  const failed = sigs.filter((s) => s.err);
  const hits = failed.filter((s) => s.err?.InstructionError?.[1]?.Custom === code);
  const span = sigs.length ? (sigs[0].blockTime - sigs.at(-1).blockTime) / 60 : 0;
  console.log(`\n##### ${label}: ${hits.length} overflow of ${failed.length} failed in ${sigs.length} sigs (${span.toFixed(1)} min)`);
  const shapes = {};
  for (const s of hits.slice(0, PER)) {
    await sleep(1600);
    const tx = await get(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
    const logs = tx?.meta?.logMessages ?? [];
    const anchor = logs.find((l) => /AnchorError/.test(l)) ?? "";
    const ixNames = logs.filter((l) => /Instruction: /.test(l)).map((l) => l.replace(/.*Instruction: /, ""));
    const progLogs = logs.filter((l) => /^Program log: (?!Instruction)/.test(l) && !/AnchorError/.test(l)).map((l) => l.slice(13, 140));
    const top = tx?.transaction?.message?.compiledInstructions?.length ?? tx?.transaction?.message?.instructions?.length;
    const key = `${anchor.replace(/.*thrown in /, "").replace(/\. Error Number.*/, "")} | ${ixNames.slice(0, 6).join(">")}`;
    shapes[key] = shapes[key] ?? { n: 0, sig: s.signature, progLogs, top, payers: new Set() };
    shapes[key].n++;
    const keys = tx?.transaction?.message?.staticAccountKeys ?? tx?.transaction?.message?.accountKeys ?? [];
    shapes[key].payers.add(String(keys[0]));
  }
  for (const [k, v] of Object.entries(shapes).sort((a, b) => b[1].n - a[1].n)) console.log(`x${v.n} senders=${v.payers.size} ixs=${v.top}  ${k}\n    ${v.sig}\n    ${v.progLogs.slice(0, 6).join("\n    ")}`);
}
