// What lands in Pump.fun's "other" refusal bucket? Samples fresh landed failures per error code, asks
// production for the verdict, assigns the worker's bucket with the same rules, and prints the ones that
// match no rule, with the failing instruction's discriminator and arguments.
//   node scripts/_pump-other.mjs [program] [perCode] [maxCodes]
import { Connection, PublicKey } from "@solana/web3.js";

const BASE = process.env.TXWHY_URL ?? "https://txwhy.vercel.app";
const PROGRAM = new PublicKey(process.argv[2] ?? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PER_CODE = Number(process.argv[3] ?? 2);
const MAX_CODES = Number(process.argv[4] ?? 8);
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", { commitment: "confirmed", disableRetryOnRateLimit: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The worker's bucket rules, copied from worker/index.ts whyNot().
function whyNot(result) {
  const text = `${result.cause?.title ?? ""} ${result.summary ?? ""} ${(result.notes ?? []).join(" ")}`;
  if (/circular arbitrage/i.test(text)) return "arbitrage";
  if (/Lighthouse guard|safety guard set by the wallet/i.test(text)) return "wallet_guard";
  if (/chains \d+ direct swaps/.test(text)) return "chained_swaps";
  if (/completed its bonding curve/.test(text)) return "pool_graduated";
  if (/Launch pool nearly full|room left before it graduates|InsufficientLiquidity|SwapAmountIsOverAThreshold/.test(text)) return "pool_nearly_full";
  if (/NonceAlreadyExists/.test(result.cause?.title ?? "")) return "duplicate_send";
  if (/moved more than \d+% against this trade/.test(text)) return "beyond_cap";
  if (/No swap found that TxWhy can re-quote|not a top-level instruction|inside another program by CPI/.test(text)) return "routed_by_private_program";
  if (/spliced in but the transaction still fails|lifted the transaction still fails|both raised \d+%/.test(text)) return "more_than_slippage";
  if (/fits its own limit/.test(text)) return "not_slippage_now";
  if (/Re-run today, this transaction fails earlier/.test(text)) return "state_changed_since";
  if (/from a private program/i.test(result.cause?.title ?? "")) return "private_program";
  if (/insufficient|holds .* lamports and needs|Shortfall/i.test(text)) return "no_funds";
  if (result.status === "needs_requote") return "needs_requote_other";
  return "other";
}

let sigs = [];
for (let i = 0; i < 4 && !sigs.length; i++) sigs = await conn.getSignaturesForAddress(PROGRAM, { limit: 1000 }).catch(async () => (await sleep(3000), []));
const failed = sigs.filter((s) => s.err);
const byCode = new Map();
for (const s of failed) {
  const ie = s.err?.InstructionError;
  const code = Array.isArray(ie) ? (ie[1] && typeof ie[1] === "object" ? ie[1].Custom : ie[1]) : JSON.stringify(s.err);
  if (!byCode.has(code)) byCode.set(code, []);
  byCode.get(code).push(s.signature);
}
const codes = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_CODES);
console.log(`${sigs.length} recent, ${failed.length} failed; codes: ${codes.map(([c, l]) => `${c}:${l.length}`).join(" ")}`);

const tally = {};
for (const [code, list] of codes) {
  for (const signature of list.slice(0, PER_CODE)) {
    let r = {};
    try {
      const res = await fetch(`${BASE}/api/v1/repair`, { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "test" }, body: JSON.stringify({ signature }), signal: AbortSignal.timeout(40_000) });
      r = await res.json();
    } catch (e) { r = { status: "network", summary: String(e) }; }
    const bucket = r.status === "repaired" ? "rebuilt" : whyNot(r);
    tally[bucket] = (tally[bucket] ?? 0) + 1;
    let shape = "";
    if (bucket === "other" || bucket === "state_changed_since") {
      const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (tx) {
        const keys = [...tx.transaction.message.staticAccountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map(String);
        const failIdx = tx.meta.err?.InstructionError?.[0];
        const ix = tx.transaction.message.compiledInstructions[failIdx];
        if (ix) {
          const data = Buffer.from(ix.data);
          const a1 = data.length >= 16 ? data.readBigUInt64LE(8) : null, a2 = data.length >= 24 ? data.readBigUInt64LE(16) : null;
          const anchorHint = (tx.meta.logMessages ?? []).filter((l) => /AnchorError|caused by account|Error Code/.test(l)).slice(-2).map((l) => l.replace("Program log: ", "")).join(" | ");
          shape = `fail ix#${failIdx + 1} program ${keys[ix.programIdIndex].slice(0, 6)} disc ${data.subarray(0, 8).toString("hex")} args ${a1} ${a2} accounts ${ix.accountKeyIndexes.length} :: ${anchorHint.slice(0, 220)}`;
        }
      }
    }
    console.log(`\n[code ${code}] ${bucket}  ${signature}\n  ${r.status} | ${r.cause?.title ?? "-"} | ${(r.summary ?? "").slice(0, 170)}${shape ? `\n  ${shape}` : ""}`);
    await sleep(2300);
  }
}
console.log("\nbuckets:", tally);
