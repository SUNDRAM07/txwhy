// Which programs actually raise the failures on Solana's busiest programs, and which of them we cannot
// name yet. Samples recent failed transactions on each watched program, reads the innermost failing
// program from the logs, and tallies by program id + error code. The unnamed ones at the top of the
// list are the next diagnosis gaps to close.
//   node scripts/who-fails.mjs [perProgram=30]
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const PER = Number(process.argv[2] ?? 30);
const WATCHED = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
};
const bundled = JSON.parse(readFileSync(new URL("../src/lib/data/program-errors.json", import.meta.url), "utf8"));
const dex = JSON.parse(readFileSync(new URL("../src/lib/data/dex-labels.json", import.meta.url), "utf8"));
const named = (id) => bundled[id]?.name ?? dex[id] ?? WATCHED[id] ?? ({ "11111111111111111111111111111111": "System", TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token", TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022", ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "ATA", ComputeBudget111111111111111111111111111111: "ComputeBudget" })[id];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tally = new Map(); // key -> {count, example, watched:Set}
let sampled = 0;
for (const [pid, label] of Object.entries(WATCHED)) {
  const sigs = (await conn.getSignaturesForAddress(new PublicKey(pid), { limit: 300 })).filter((s) => s.err).slice(0, PER);
  for (const s of sigs) {
    let tx = null;
    for (let a = 0; a < 3 && !tx; a++) { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null); if (!tx) await sleep(700); }
    await sleep(180);
    if (!tx) continue;
    sampled++;
    const logs = tx.meta?.logMessages ?? [];
    const failedLine = logs.find((l) => / failed: /.test(l) && /^Program \w+ failed/.test(l));
    const culprit = failedLine?.match(/^Program (\w+) failed/)?.[1] ?? "?";
    const ie = tx.meta?.err?.InstructionError;
    const code = Array.isArray(ie) ? (typeof ie[1] === "object" && ie[1] ? (ie[1].Custom ?? JSON.stringify(ie[1])) : ie[1]) : JSON.stringify(tx.meta?.err).slice(0, 30);
    const outerIx = Array.isArray(ie) ? (tx.transaction.message.compiledInstructions ?? tx.transaction.message.instructions)[ie[0]] : null;
    const keys = [...(tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map((k) => k.toBase58());
    const outer = outerIx ? keys[outerIx.programIdIndex] : "?";
    const key = `${named(culprit) ? named(culprit) : "UNNAMED " + culprit} | code ${code}${outer !== culprit ? ` | outer ${named(outer) ?? "UNNAMED " + outer.slice(0, 12)}` : ""}`;
    const row = tally.get(key) ?? { count: 0, example: s.signature, on: new Set() };
    row.count++; row.on.add(label); tally.set(key, row);
  }
}
const rows = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
const unnamed = rows.filter(([k]) => k.startsWith("UNNAMED")).reduce((n, [, r]) => n + r.count, 0);
console.log(`${sampled} failed transactions sampled; ${unnamed} (${Math.round((unnamed / sampled) * 100)}%) raised by programs we cannot name\n`);
for (const [k, r] of rows.slice(0, 40)) console.log(`${String(r.count).padStart(4)}  ${k}\n        on ${[...r.on].join(", ")} · e.g. ${r.example}`);
