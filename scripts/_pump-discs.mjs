// Which Pump.fun instructions do recent landed failures use? Counts discriminators over the last N failed signatures.
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
const PUMP = process.env.PROGRAM ?? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = Number(process.argv[2] ?? 60);
const sigs = (await conn.getSignaturesForAddress(new PublicKey(PUMP), { limit: 300 })).filter((s) => s.err).slice(0, N);
const tally = {};
for (const s of sigs) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  await sleep(700);
  if (!tx) continue;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses }).staticAccountKeys.concat(tx.meta?.loadedAddresses?.writable ?? [], tx.meta?.loadedAddresses?.readonly ?? []);
  const seen = new Set();
  for (const ix of tx.transaction.message.compiledInstructions) {
    if (keys[ix.programIdIndex]?.toBase58() !== PUMP) continue;
    seen.add(Buffer.from(ix.data.slice(0, 8)).toString("hex"));
  }
  for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) {
    if (keys[ix.programIdIndex]?.toBase58() !== PUMP) continue;
    const bytes = Buffer.from(bs58.decode(ix.data)); seen.add(bytes.subarray(0, 8).toString("hex"));
  }
  if (!seen.size) seen.add("none-top-or-inner");
  for (const d of seen) tally[d] = (tally[d] ?? 0) + 1;
}
console.log(`${sigs.length} failed Pump.fun transactions; discriminators seen (top-level or inner):`);
for (const [d, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(4), d);
