// Infer the layout of Pump.fun instructions the IDL does not list: for each discriminator, show a few transactions'
// "Instruction:" log line, data length and u64 args, account count, and for landed successes the token/SOL deltas of the payer.
//   node scripts/_pump-newix.mjs 1c92de7726c469d5 e1f7501ed5b38488
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
const PUMP = process.env.PROGRAM ?? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WANT = new Set(process.argv.slice(2));
const found = {};
const sigs = await conn.getSignaturesForAddress(new PublicKey(PUMP), { limit: 400 });
for (const s of sigs) {
  if ([...WANT].every((d) => (found[d]?.length ?? 0) >= 4)) break;
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null);
  await sleep(800);
  if (!tx) continue;
  const keys = tx.transaction.message.staticAccountKeys.concat(tx.meta?.loadedAddresses?.writable ?? [], tx.meta?.loadedAddresses?.readonly ?? []);
  const calls = [];
  tx.transaction.message.compiledInstructions.forEach((ix, i) => { if (keys[ix.programIdIndex]?.toBase58() === PUMP) calls.push({ where: `top#${i}`, data: Buffer.from(ix.data), accounts: ix.accountKeyIndexes.map((k) => keys[k]?.toBase58()) }); });
  for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) { if (keys[ix.programIdIndex]?.toBase58() === PUMP) calls.push({ where: `inner of #${inner.index}`, data: Buffer.from(bs58.decode(ix.data)), accounts: ix.accounts.map((k) => keys[k]?.toBase58()) }); }
  for (const c of calls) {
    const disc = c.data.subarray(0, 8).toString("hex");
    if (!WANT.has(disc) || (found[disc]?.length ?? 0) >= 4) continue;
    const u64s = []; for (let o = 8; o + 8 <= c.data.length; o += 8) u64s.push(c.data.readBigUInt64LE(o).toString());
    const rest = c.data.length - 8 - u64s.length * 8;
    const ixLog = (tx.meta?.logMessages ?? []).filter((l) => /Instruction:/.test(l)).map((l) => l.replace("Program log: Instruction: ", "")).join(",");
    const payer = keys[0].toBase58();
    const solDelta = tx.meta ? (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9 : null;
    const tok = (tx.meta?.postTokenBalances ?? []).filter((b) => b.owner === payer).map((b) => { const pre = (tx.meta.preTokenBalances ?? []).find((p) => p.accountIndex === b.accountIndex); return `${b.mint.slice(0, 6)}:${(Number(b.uiTokenAmount.uiAmount ?? 0) - Number(pre?.uiTokenAmount.uiAmount ?? 0)).toFixed(3)}`; }).join(" ");
    (found[disc] ??= []).push(`${s.err ? "FAIL" : "ok  "} ${s.signature.slice(0, 10)} ${c.where} len ${c.data.length} u64s [${u64s.join(", ")}] tail ${rest}B accounts ${c.accounts.length} | ${ixLog} | payer SOL ${solDelta?.toFixed(4)} tokens ${tok}`);
  }
}
for (const [d, rows] of Object.entries(found)) { console.log(`\n== ${d}`); for (const r of rows) console.log("  " + r); }
