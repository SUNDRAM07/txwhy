// A live, non-migrated pump.fun curve with recent trades: mint, bonding curve PDA, reserves and the complete flag.
import { Connection, PublicKey } from "@solana/web3.js";
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sigs = (await conn.getSignaturesForAddress(PUMP, { limit: 60 })).filter((s) => !s.err);
const seen = new Set();
for (const s of sigs) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  await sleep(900);
  if (!tx) continue;
  const keys = tx.transaction.message.staticAccountKeys.concat(tx.meta?.loadedAddresses?.writable ?? [], tx.meta?.loadedAddresses?.readonly ?? []);
  const mints = (tx.meta?.postTokenBalances ?? []).map((b) => b.mint).filter((m) => m.endsWith("pump") && !seen.has(m));
  for (const mint of mints) {
    seen.add(mint);
    const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP);
    const info = await conn.getAccountInfo(curve).catch(() => null);
    await sleep(600);
    if (!info || !info.owner.equals(PUMP)) continue;
    const d = info.data; // 8 disc | u64 virtual_token | u64 virtual_sol | u64 real_token | u64 real_sol | u64 supply | bool complete
    const u = (o) => d.readBigUInt64LE(o);
    const complete = d[48] === 1;
    console.log(`${complete ? "COMPLETE" : "live    "} mint ${mint} curve ${curve.toBase58()} vTok ${u(8)} vSol ${u(16)} rTok ${u(24)} rSol ${u(32)} (tx ${s.signature.slice(0, 8)})`);
    if (!complete && u(24) > 0n) { process.exit(0); }
  }
}
