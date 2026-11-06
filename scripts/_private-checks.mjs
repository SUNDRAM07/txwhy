// How many landed failures are a private program's own named check? For each watched program: sample recent
// failures, find the innermost failing program in the logs, and count the ones where that program is outside the
// catalog yet named its error in an Anchor log line (code 6000 or above).   node scripts/_private-checks.mjs [perProgram]
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const WATCHED = { Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Raydium AMM": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Orca Whirlpool": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Meteora DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", PumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "Meteora DBC": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "Meteora DAMM v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "Raydium LaunchLab": "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" };
// The catalog, read from source so this script and the engine agree on what "named" means.
const src = ["src/lib/programs.ts", "src/lib/data/program-errors.json", "src/lib/data/dex.json"].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const named = (id) => src.includes(id);
const ANCHOR = /AnchorError (?:thrown in (.+?):\d+|caused by account: (\w+)|occurred)\. Error Code: (\w+)\. Error Number: (\d+)\./;
const PER = Number(process.argv[2] ?? 20);
let total = 0, hits = 0; const byCheck = {};
for (const [label, id] of Object.entries(WATCHED)) {
  const sigs = (await get(() => conn.getSignaturesForAddress(new PublicKey(id), { limit: 1000 }))) ?? [];
  const failed = sigs.filter((s) => s.err?.InstructionError?.[1]?.Custom >= 6000);
  const allFailed = sigs.filter((s) => s.err).length;
  const step = Math.max(1, Math.floor(failed.length / PER));
  const sample = failed.filter((_, i) => i % step === 0).slice(0, PER);
  let n = 0, priv = 0;
  for (const s of sample) {
    await sleep(1800);
    const tx = await get(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
    const logs = tx?.meta?.logMessages ?? [];
    if (!logs.length) continue;
    n++;
    const culprit = logs.map((l) => l.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/)).find(Boolean)?.[1];
    const a = logs.map((l) => l.match(ANCHOR)).find((m) => m && Number(m[4]) === s.err.InstructionError[1].Custom);
    if (culprit && !named(culprit) && a) {
      priv++;
      const k = `${a[3]} @ ${culprit.slice(0, 4)}…${culprit.slice(-4)}${a[1] ? ` (${a[1].replace(/^programs\//, "").split("/")[0]})` : ""}`;
      byCheck[k] = (byCheck[k] ?? 0) + 1;
    }
  }
  total += n; hits += priv;
  console.log(`${label.padEnd(18)} failed ${String(allFailed).padStart(4)}/1000, custom>=6000: ${String(failed.length).padStart(4)}, sampled ${String(n).padStart(2)}, private named checks ${priv}`);
}
console.log(`\n${hits} of ${total} sampled custom-code failures are a private program's own named check`);
for (const [k, v] of Object.entries(byCheck).sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k);
