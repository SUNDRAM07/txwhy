// pump_buy_guard (52Yy…foAi): how busy, how often it refuses, and what its arguments mean. For each sampled buy:
// the four u64 arguments, and the bonding curve's SOL just before (from the transaction's own preBalances).
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const GUARD = new PublicKey("52Yyvsugd3B7waLEFB83hdTmcwtU66tBuEzTQ7kcfoAi");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const sigs = (await get(() => conn.getSignaturesForAddress(GUARD, { limit: 1000 }))) ?? [];
const failed = sigs.filter((s) => s.err);
const codes = {};
for (const s of failed) { const c = s.err.InstructionError?.[1]?.Custom ?? JSON.stringify(s.err).slice(0, 30); codes[c] = (codes[c] ?? 0) + 1; }
const span = sigs.length ? (sigs[0].blockTime - sigs.at(-1).blockTime) : 0;
console.log(`guard: ${sigs.length} signatures over ${(span / 60).toFixed(1)} min, ${failed.length} failed. codes: ${Object.entries(codes).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(" ")}`);
const N = Number(process.argv[2] ?? 8);
const pick = [...sigs.filter((s) => !s.err).slice(0, N), ...failed.filter((s) => s.err.InstructionError?.[1]?.Custom === 6017).slice(0, N)];
const payers = new Set();
for (const s of pick) {
  await sleep(2200);
  const tx = await get(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }));
  if (!tx) continue;
  const msg = tx.transaction.message;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
  const all = []; for (let i = 0; i < keys.length; i++) all.push(keys.get(i).toBase58());
  payers.add(all[0]);
  const ix = msg.compiledInstructions.find((i) => keys.get(i.programIdIndex).equals(GUARD));
  if (!ix) { console.log(s.err ? "FAIL" : "ok  ", "(guard called by CPI)", s.signature.slice(0, 10)); continue; }
  const d = Buffer.from(ix.data);
  const disc = d.subarray(0, 8).toString("hex");
  const args = []; for (let o = 8; o + 8 <= d.length; o += 8) args.push(d.readBigUInt64LE(o));
  const mint = keys.get(ix.accountKeyIndexes[1]);
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
  const ci = all.indexOf(curve.toBase58());
  const pre = ci >= 0 ? tx.meta.preBalances[ci] / 1e9 : null;
  const post = ci >= 0 ? tx.meta.postBalances[ci] / 1e9 : null;
  console.log(s.err ? "FAIL" : "ok  ", disc, "args", args.map(String).join(" | "), "| curve SOL pre", pre?.toFixed(4), "post", post?.toFixed(4), "| accounts", ix.accountKeyIndexes.length, s.signature.slice(0, 10));
}
console.log("distinct fee payers in sample:", payers.size);
