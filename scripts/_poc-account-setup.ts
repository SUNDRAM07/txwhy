// Controlled proof of the token-account setup repair: a real PumpSwap buy for a funded wallet, with the
// SDK's account-creation instruction stripped, so the buy fails on the missing receiving account
// (AccountNotInitialized, 3012). The local engine should insert an idempotent creation of that account,
// then handle whatever the swap does next, and the verifier must accept the result.
//   npx tsx scripts/_poc-account-setup.ts <funded fee payer pubkey>
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { buildStalePumpSwapBuy } from "../src/lib/pump-demo";
import { repair } from "../src/lib/repair";
import { RPC_URL } from "../src/lib/rpc";

const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

async function main() {
  const payer = new PublicKey(process.argv[2] ?? "");
  const conn = new Connection(RPC_URL, "confirmed");
  const { instructions, description } = await buildStalePumpSwapBuy(payer);
  const created = instructions.filter((ix) => ix.programId.toBase58() === ATA);
  const stripped = instructions.filter((ix) => ix.programId.toBase58() !== ATA);
  console.log(description);
  console.log(`instructions: ${instructions.length}, account creations stripped: ${created.length}`);
  for (const ix of created) {
    const account = ix.keys[1]?.pubkey;
    const info = account ? await conn.getAccountInfo(account) : null;
    console.log(`  stripped creation of ${account?.toBase58()} (exists on chain today: ${info != null})`);
  }
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: stripped }).compileToV0Message();
  const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
  const r = await repair({ transaction: b64 });
  console.log(
    JSON.stringify(
      {
        status: r.status,
        cause: r.cause?.title,
        summary: r.summary,
        changes: r.changes.map((c) => ({ type: c.type, before: c.before, after: c.after })),
        verification: r.verification ? { ok: r.verification.ok, kept: r.verification.kept, changes: r.verification.changes.map((c) => c.kind), violations: r.verification.violations } : null,
        simulation: { passed: r.simulation.passed, error: r.simulation.error?.title },
        notes: r.notes,
      },
      null,
      1,
    ),
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
