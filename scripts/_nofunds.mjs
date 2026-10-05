import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection("https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (f) => { for (let i = 0; i < 8; i++) { try { return await f(); } catch { await sleep(4000); } } return null; };
const SOL = "So11111111111111111111111111111111111111112";
const [prog, code, n] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4] ?? 10)];
const all = ((await get(() => conn.getSignaturesForAddress(new PublicKey(prog), { limit: 1000 }))) ?? []).filter((s) => s.err?.InstructionError?.[1]?.Custom === code);
const step = Math.max(1, Math.floor(all.length / n));
const sigs = all.filter((_, i) => i % step === 0).slice(0, n);
const signers = new Set(); let topLevel = 0, hasWrap = 0, solIn = 0, tokenIn = 0;
for (const s of sigs) {
  await sleep(2600);
  const t = await get(() => conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
  if (!t) continue;
  const ixs = t.transaction.message.instructions;
  const failIdx = s.err.InstructionError[0];
  const fail = ixs[failIdx];
  const top = fail.programId.toBase58() === prog;
  if (top) topLevel++;
  const wrap = ixs.some((ix) => ix.parsed?.type === "transfer" && ix.program === "system") && ixs.some((ix) => ix.parsed?.type === "syncNative");
  if (wrap) hasWrap++;
  signers.add(t.transaction.message.accountKeys[0].pubkey.toBase58());
  // Which token ran short: look at pre balances of the user's input token account.
  const inner = (t.meta.innerInstructions ?? []).find((g) => g.index === failIdx)?.instructions ?? [];
  const xfer = inner.find((ix) => ix.parsed?.type === "transferChecked" || ix.parsed?.type === "transfer");
  const mint = xfer?.parsed?.info?.mint;
  if (mint === SOL) solIn++; else if (mint) tokenIn++;
  const pre = (t.meta.preTokenBalances ?? []).find((b) => b.mint === mint && b.owner === t.transaction.message.accountKeys[0].pubkey.toBase58());
  console.log(`${s.signature.slice(0, 8)} top=${top} wrap=${wrap} ixs=${ixs.length} in=${mint === SOL ? "SOL" : mint ? "token" : "?"} needed=${xfer?.parsed?.info?.tokenAmount?.uiAmountString ?? xfer?.parsed?.info?.amount ?? "?"} had=${pre?.uiTokenAmount?.uiAmountString ?? "none"} signer=${t.transaction.message.accountKeys[0].pubkey.toBase58().slice(0, 6)}`);
}
console.log(`[${prog.slice(0, 6)} code ${code}] ${all.length}/1000 hits; sampled ${sigs.length}: topLevel=${topLevel} withWrap=${hasWrap} solIn=${solIn} tokenIn=${tokenIn} distinct signers=${signers.size}`);
