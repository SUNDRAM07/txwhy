// The swap's source mint is read from the transaction when the transaction creates the account itself (a wrapped-SOL
// account created and closed around the swap), so a Jupiter re-quote no longer needs the chain to have the account.
// First block: no network. Last check replays a landed version 1 Jupiter failure (Nov 12 2026) and needs the RPC.
// Run: npx tsx scripts/test-source-mint.ts
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { mintFromTransaction } from "../src/lib/requote";
import { repair } from "../src/lib/repair";

let failed = 0;
function ok(name: string, pass: boolean, detail = "") {
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n     ${detail}`}`);
}
const k = (s: string) => ({ pubkey: new PublicKey(s), isSigner: false, isWritable: true });
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SYSTEM = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const payer = "abcdEvoXux3WaRi8RBujiNuoXmrXdVZTFcY5cuPgS2L";
const wsolAccount = "EebrRoD1R2bKqerk1w9zQk2mydWpLkBtuhe7qw8ryK25";
const other = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const createIdempotent = new TransactionInstruction({ programId: new PublicKey(ATA), keys: [k(payer), k(wsolAccount), k(payer), k(WSOL), k(SYSTEM), k(TOKEN)], data: Buffer.from([1]) });
const createPlain = new TransactionInstruction({ programId: new PublicKey(ATA), keys: [k(payer), k(other), k(payer), k(USDC), k(SYSTEM), k(TOKEN)], data: Buffer.alloc(0) });
const init3 = new TransactionInstruction({ programId: new PublicKey(TOKEN), keys: [k(other), k(USDC)], data: Buffer.from([18, ...new Array(32).fill(0)]) });
const transfer = new TransactionInstruction({ programId: new PublicKey(TOKEN), keys: [k(wsolAccount), k(other), k(payer)], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 1]) });

ok("associated-token createIdempotent names the mint", mintFromTransaction([transfer, createIdempotent], wsolAccount) === WSOL);
ok("plain associated-token create (empty data) names the mint", mintFromTransaction([createPlain], other) === USDC);
ok("SPL InitializeAccount3 names the mint", mintFromTransaction([init3], other) === USDC);
ok("a transfer touching the account is not a creation", mintFromTransaction([transfer], wsolAccount) === null);
ok("an account the transaction does not create stays unresolved", mintFromTransaction([createIdempotent, init3], payer) === null);
ok("the account must be in the created slot, not the funder slot", mintFromTransaction([createIdempotent], payer) === null);

async function main() {
  // Landed v1 Jupiter route whose wrapped-SOL source account is created and closed inside the transaction.
  const r = await repair({ signature: "3761XBCq6SzAYGXytCcwgzdrYGYGCMezyv3RkdrH2WA7wnoArs1DaX7UuuobLXR2KwRP9Q5XS8g2g6H9yDssxqwH" });
  const unresolved = r.notes.find((n) => /Could not resolve the swap/.test(n));
  ok("the landed v1 swap's tokens resolve (no 'Could not resolve' note)", !unresolved, unresolved ?? "");
  ok("the engine went on to re-quote or to give a priced reason", r.status === "repaired" || r.notes.some((n) => /New route|moved more than|fresh quote was spliced|fits its own limit|price impact|64 distinct accounts|still fails|Could not get a fresh route/i.test(n)), JSON.stringify({ status: r.status, notes: r.notes }).slice(0, 500));
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
