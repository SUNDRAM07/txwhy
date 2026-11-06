// Which unnamed programs are behind the failures the index files as "private program"? Samples recent failures on
// the nine watched programs, takes the innermost failing program from the logs, and ranks the ones outside the
// catalog, with their error codes and whether the transaction's top-level program was theirs (a router) or a DEX.
//   node scripts/_private-culprits.mjs [perProgram]
import { Connection, PublicKey } from "@solana/web3.js";
import fs from "node:fs";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const WATCHED = { Jupiter: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "Raydium AMM": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", "Orca Whirlpool": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", "Meteora DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", "Pump.fun": "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", PumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", "Meteora DBC": "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", "Meteora DAMM v2": "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", "Raydium LaunchLab": "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj" };
const src = ["src/lib/programs.ts", "src/lib/data/program-errors.json", "src/lib/data/dex-labels.json"].map((f) => fs.readFileSync(f, "utf8")).join("\n");
const named = (id) => src.includes(id);
const ANCHOR = /AnchorError (?:thrown in (.+?):\d+|caused by account: (\w+)|occurred)\. Error Code: (\w+)\./;
const PER = Number(process.argv[2] ?? 30);
const rows = new Map(); let sampled = 0, priv = 0;
for (const [label, id] of Object.entries(WATCHED)) {
  const sigs = (await get(() => conn.getSignaturesForAddress(new PublicKey(id), { limit: 1000 }))) ?? [];
  const failed = sigs.filter((s) => s.err);
  const step = Math.max(1, Math.floor(failed.length / PER));
  for (const s of failed.filter((_, i) => i % step === 0).slice(0, PER)) {
    await sleep(1700);
    const tx = await get(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
    const logs = tx?.meta?.logMessages ?? [];
    if (!logs.length) continue;
    sampled++;
    const culprit = logs.map((l) => l.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/)).find(Boolean)?.[1];
    if (!culprit || named(culprit)) continue;
    priv++;
    const r = rows.get(culprit) ?? { n: 0, codes: {}, crate: null, in: {}, payers: new Set(), sig: s.signature };
    r.n++;
    const code = s.err.InstructionError?.[1]?.Custom ?? JSON.stringify(s.err.InstructionError?.[1] ?? "?").slice(0, 18);
    const a = logs.map((l) => l.match(ANCHOR)).find(Boolean);
    const key = a ? `${code} ${a[3]}` : String(code);
    r.codes[key] = (r.codes[key] ?? 0) + 1;
    if (a?.[1]) r.crate = a[1].replace(/^programs\//, "").split("/")[0];
    r.in[label] = (r.in[label] ?? 0) + 1;
    r.payers.add(tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses }).get(0).toBase58());
    rows.set(culprit, r);
  }
  console.error(`${label}: done`);
}
console.log(`${sampled} failures sampled; ${priv} (${(100 * priv / sampled).toFixed(1)}%) failed inside a program outside the catalog; ${rows.size} distinct programs\n`);
for (const [id, r] of [...rows].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) {
  console.log(`${String(r.n).padStart(3)}  ${id}${r.crate ? `  (${r.crate})` : ""}\n       senders ${r.payers.size} | seen on ${Object.entries(r.in).map(([k, v]) => `${k} ${v}`).join(", ")}\n       codes ${Object.entries(r.codes).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} x${v}`).join("; ")}\n       e.g. ${r.sig}`);
}
