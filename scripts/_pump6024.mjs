// What is behind Pump.fun "Overflow" (6024)? Sample fresh ones and print the failing instruction, its args and the curve state lines.
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
let sigs = [];
for (let i = 0; i < 5 && !sigs.length; i++) sigs = await conn.getSignaturesForAddress(new PublicKey(PUMP), { limit: 1000 }).catch(async () => (await sleep(4000), []));
const wanted = sigs.filter((s) => s.err?.InstructionError?.[1]?.Custom === 6024).slice(0, 6);
console.log(`${sigs.length} recent, ${wanted.length} with 6024`);
for (const s of wanted) {
  await sleep(1500);
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
  if (!tx) continue;
  const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map(String);
  const failIdx = tx.meta.err.InstructionError[0];
  const ix = tx.transaction.message.compiledInstructions[failIdx];
  const prog = keys[ix.programIdIndex];
  const data = Buffer.from(ix.data);
  const disc = data.subarray(0, 8).toString("hex");
  const a1 = data.length >= 16 ? data.readBigUInt64LE(8) : null, a2 = data.length >= 24 ? data.readBigUInt64LE(16) : null;
  const logs = tx.meta.logMessages.filter((l) => /Instruction:|Error|overflow|AnchorError|Program log/.test(l)).slice(-6);
  console.log(`\n${s.signature.slice(0, 14)} fail ix#${failIdx} program ${prog.slice(0, 8)} disc ${disc} args ${a1} ${a2} accounts ${ix.accountKeyIndexes.length}`);
  for (const l of logs) console.log("   " + l.slice(0, 140));
}
