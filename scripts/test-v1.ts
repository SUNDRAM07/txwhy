// Version 1 (SIMD-0385) repairs, end to end against mainnet through the engine. Run: npx tsx scripts/test-v1.ts
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { repair } from "../src/lib/repair";
import { buildV1, decodeV1, toWeb3 } from "../src/lib/v1";

const payer = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"); // public exchange wallet: nobody can sign these
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const rpc = (method: string, params: unknown[]) =>
  fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
const J = "https://lite-api.jup.ag/swap/v1";

let pass = 0;
let total = 0;
function check(name: string, ok: boolean, detail = "") {
  total++;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}

async function main() {
  const { blockhash } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).result.value;
  const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });
  const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("txwhy v1") });

  // 1. Compute limit far too low, no loaded-data limit (which in v1 means zero bytes).
  {
    const tx = buildV1(payer, blockhash, [transfer, memo], { computeUnitLimit: 100 });
    const r = await repair({ transaction: tx });
    const types = r.changes.map((c) => c.type);
    check("v1 compute limit too low", r.status === "repaired" && types.includes("compute_unit_limit") && types.includes("loaded_accounts_data_limit") && r.simulation.passed && r.verification?.ok === true, `${r.status} | ${types.join(",")} | ${r.summary.slice(0, 80)}`);
    if (r.repairedTransaction) {
      const out = decodeV1(r.repairedTransaction);
      check("  output is v1 with edited header and identical instructions", out.config.computeUnitLimit! > 100 && out.config.loadedAccountsDataSizeLimit! > 0 && out.instructions.length === 2 && out.instructions[1].data.toString() === "txwhy v1", `config ${JSON.stringify(out.config, (_, v) => (typeof v === "bigint" ? v.toString() : v))} | ${out.bytes} bytes`);
      const sim = await rpc("simulateTransaction", [r.repairedTransaction, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }]);
      check("  output simulates on a public node", sim.result?.value?.err == null, JSON.stringify(sim.result?.value?.err ?? sim.error));
    }
  }

  // 2. Expired blockhash on a v1 transaction.
  {
    const stale = "11111111111111111111111111111111";
    const tx = buildV1(payer, stale, [transfer, memo], { computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 1_000_000 });
    const r = await repair({ transaction: tx });
    check("v1 expired blockhash", r.status === "repaired" && r.changes.some((c) => c.type === "blockhash") && r.simulation.passed, `${r.status} | ${r.changes.map((c) => c.type).join(",")}`);
  }

  // 3. Already valid v1: nothing to change beyond a possible fee.
  {
    const tx = buildV1(payer, blockhash, [transfer, memo], { computeUnitLimit: 20_000, loadedAccountsDataSizeLimit: 1_000_000, priorityFeeLamports: BigInt(2_000_000) });
    const r = await repair({ transaction: tx });
    check("v1 already valid", (r.status === "valid" || r.status === "repaired") && r.simulation.passed && !r.changes.some((c) => c.type === "compute_unit_limit" && /needs/.test(c.reason)), `${r.status} | ${r.changes.map((c) => c.type).join(",") || "no changes"}`);
  }

  // 4. Jupiter swap on a stale quote, carried in a v1 transaction.
  {
    const q = await (await fetch(`${J}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=50000000&slippageBps=50`)).json();
    const stale = { ...q, outAmount: String(Math.floor(Number(q.outAmount) * 1.05)), otherAmountThreshold: String(Math.floor(Number(q.otherAmountThreshold) * 1.05)) };
    const built = await (await fetch(`${J}/swap-instructions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse: stale, userPublicKey: payer.toBase58(), wrapAndUnwrapSol: true }) })).json();
    const conv = (ix: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }) =>
      new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })), data: Buffer.from(ix.data, "base64") });
    const ixs = [...(built.setupInstructions ?? []), built.swapInstruction, ...(built.cleanupInstruction ? [built.cleanupInstruction] : [])].map(conv);
    const tx = buildV1(payer, blockhash, ixs, { computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: 32 * 1024 * 1024 });
    const r = await repair({ transaction: tx });
    check("v1 swap on a stale quote", r.status === "repaired" && r.changes.some((c) => c.type === "swap_quote") && r.simulation.passed && r.verification?.ok === true, `${r.status} | ${r.changes.map((c) => c.type).join(",")} | ${r.summary.slice(0, 70)} | ${r.notes.find((n) => /route|accounts/i.test(n))?.slice(0, 80) ?? ""}`);
    if (r.repairedTransaction) {
      const out = decodeV1(r.repairedTransaction);
      check("  output is v1, verified: instructions kept except the swap", out.bytes <= 4096 && (r.verification?.kept ?? 0) >= ixs.length - 1, `${out.bytes} bytes | kept ${r.verification?.kept}`);
    }
  }

  // 5. A real landed v1 transaction by signature still gets a diagnosis (bot program, expected not repairable).
  {
    const r = await repair({ signature: "3T7bjJiEWLgFt56urafmwQEkPwG6n9yy7d9uE8HwogAsfzozjLG14pBdATUoDtcPpvHnn38T41YdgTi4TXxDP9bV" });
    check("real landed v1 by signature", r.cause != null && r.status !== "valid", `${r.status} | ${r.cause?.title} | ${r.notes[0]?.slice(0, 60) ?? ""}`);
  }

  console.log(`\n${pass}/${total} passed`);
  process.exit(pass === total ? 0 : 1);
}
main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
void toWeb3;
