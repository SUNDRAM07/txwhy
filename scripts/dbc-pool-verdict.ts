// Exercise the Meteora DBC pool-state verdicts against live mainnet state.
//   npx tsx scripts/dbc-pool-verdict.ts [signature]
// 1. A landed 6033/6013 failure through the whole engine (default: a buy that overshot a pool that has since graduated).
// 2. The helper alone on a pool that is still on its curve, with a fabricated oversized buy, to see the room-left figures.
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { dbcPoolVerdict, repair } from "../src/lib/repair";
import { METEORA_DBC } from "../src/lib/swap-shape";

const DBC = new PublicKey(METEORA_DBC);
const conn = new Connection(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const signature = process.argv[2] ?? "4scTFL75gaSFxHYkFVfSQEWQRePQ1f4Zjfu9tuS1jc5cUnyxf4F1Btiq6JVXmopzxzyhYdyVF9hbLyVhaTCffGpP";
  const r = await repair({ signature });
  console.log("ENGINE", r.status, "|", r.summary);
  console.log("  cause:", r.cause?.title, "|", r.cause?.cause);
  console.log("  fix:", r.cause?.fix);
  console.log("  notes:", r.notes.join(" || ").slice(0, 600));

  // Find a pool still on its curve from recent successful DBC swaps.
  await sleep(2000);
  const sigs = await conn.getSignaturesForAddress(DBC, { limit: 60 });
  const ok = sigs.filter((s) => !s.err).slice(0, 15);
  for (const s of ok) {
    await sleep(1500);
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!tx) continue;
    const keys = [
      ...tx.transaction.message.staticAccountKeys,
      ...(tx.meta?.loadedAddresses?.writable ?? []),
      ...(tx.meta?.loadedAddresses?.readonly ?? []),
    ];
    const ix = tx.transaction.message.compiledInstructions.find((i) => keys[i.programIdIndex]?.equals(DBC) && i.accountKeyIndexes.length >= 10);
    if (!ix) continue;
    const data = Buffer.from(ix.data);
    const disc = data.subarray(0, 8).toString("hex");
    if (disc !== "f8c69e91e17587c8" && disc !== "414b3f4ceb5b5b88") continue;
    // The same swap with a buy of 1,000 SOL, which no launch pool can take.
    const fat = Buffer.from(data);
    fat.writeBigUInt64LE(BigInt(1_000e9), 8);
    const fake = new TransactionInstruction({
      programId: DBC,
      keys: ix.accountKeyIndexes.map((k) => ({ pubkey: keys[k], isSigner: false, isWritable: true })),
      data: fat,
    });
    const verdict = await dbcPoolVerdict([fake], { title: "InsufficientLiquidity", code: "Custom(6033) — 0x1791", cause: "", fix: "" }, [`Program ${METEORA_DBC} failed: custom program error: 0x1791`]);
    console.log("\nHELPER on pool", keys[ix.accountKeyIndexes[2]].toBase58(), "from", s.signature.slice(0, 12));
    console.log("  title:", verdict?.cause.title);
    console.log("  cause:", verdict?.cause.cause);
    console.log("  fix:", verdict?.cause.fix);
    console.log("  note:", verdict?.note);
    if (verdict?.cause.title === "Launch pool nearly full") break;
  }
}
main().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
