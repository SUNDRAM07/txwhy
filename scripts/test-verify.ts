// Adversarial tests for the repair verifier. No network. Run: npx tsx scripts/test-verify.ts
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { verifyInstructions } from "../src/lib/verify";

const payer = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const dest = Keypair.generate().publicKey;
const thief = Keypair.generate().publicKey;
const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL = new PublicKey("So11111111111111111111111111111111111111112");

/** A route_v2 instruction: discriminator, in_amount, quoted_out, slippage_bps, fee_bps, positive_slippage_bps, route bytes. */
function swap(opts: { user?: PublicKey; out?: PublicKey; amount?: bigint; quoted?: bigint; slippage?: number; route?: number; source?: PublicKey; receiver?: PublicKey; altReceiver?: PublicKey }) {
  const data = Buffer.alloc(8 + 8 + 8 + 2 + 2 + 2 + 4);
  Buffer.from("bb64facc31c4af14", "hex").copy(data, 0);
  data.writeBigUInt64LE(opts.amount ?? BigInt(1_000_000), 8);
  data.writeBigUInt64LE(opts.quoted ?? BigInt(5_000_000), 16);
  data.writeUInt16LE(opts.slippage ?? 50, 24);
  data.writeUInt32LE(opts.route ?? 1, 30);
  const k = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  return new TransactionInstruction({
    programId: JUP,
    // route_v2 accounts: user, user source, user destination, source mint, destination mint, token programs x2, optional destination
    keys: [k(opts.user ?? payer, true), k(opts.source ?? other), k(opts.receiver ?? dest), k(SOL), k(opts.out ?? USDC), k(SOL), k(SOL), k(opts.altReceiver ?? JUP)],
    data,
  });
}
/** The same trade expressed as shared_accounts_route_v2, whose accounts sit in different slots. */
function sharedSwap(opts: { receiver?: PublicKey; quoted?: bigint }) {
  const data = Buffer.alloc(8 + 1 + 8 + 8 + 2 + 2 + 2 + 4);
  Buffer.from("d19853937cfed8e9", "hex").copy(data, 0);
  data.writeBigUInt64LE(BigInt(1_000_000), 9);
  data.writeBigUInt64LE(opts.quoted ?? BigInt(4_600_000), 17);
  data.writeUInt16LE(50, 25);
  const k = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  // program authority, user, source, program source, program destination, destination, source mint, destination mint
  return new TransactionInstruction({ programId: JUP, keys: [k(JUP), k(payer, true), k(other), k(SOL), k(SOL), k(opts.receiver ?? dest), k(SOL), k(USDC)], data });
}

const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from("order-42") });
const feeTransfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 5000 });
const ataCreate = new TransactionInstruction({ programId: ATA, keys: [{ pubkey: payer, isSigner: true, isWritable: true }], data: Buffer.from([1]) });
const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const price = (microLamports: number) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });

const PUMPSWAP = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/** A PumpSwap buy: discriminator, base_amount_out u64, max_quote_amount_in u64, track_volume flag. */
function pumpBuy(opts: { amount?: bigint; max?: bigint; user?: PublicKey; tail?: number }) {
  const data = Buffer.alloc(8 + 8 + 8 + 2);
  Buffer.from("66063d1201daebea", "hex").copy(data, 0);
  data.writeBigUInt64LE(opts.amount ?? BigInt(1_000_000), 8);
  data.writeBigUInt64LE(opts.max ?? BigInt(100_000), 16);
  data.writeUInt16LE(opts.tail ?? 1, 24);
  const k = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  return new TransactionInstruction({ programId: PUMPSWAP, keys: [k(dest), k(opts.user ?? payer, true), k(other), k(SOL), k(USDC)], data });
}
const pumpOriginal = [limit(100), pumpBuy({}), memo];
/** Direct (PumpSwap) swaps: only the limit may move, and only within the cap. */
const directCases: [string, TransactionInstruction[], boolean][] = [
  ["pump buy: max cost raised 10%", [limit(180_000), pumpBuy({ max: BigInt(110_000) }), memo], true],
  ["pump buy: max cost lowered (better for the user)", [limit(180_000), pumpBuy({ max: BigInt(90_000) }), memo], true],
  ["pump buy: max cost raised exactly to the 25% cap", [limit(180_000), pumpBuy({ max: BigInt(125_000) }), memo], true],
  ["ATTACK: pump buy max cost raised 26%", [limit(180_000), pumpBuy({ max: BigInt(126_000) }), memo], false],
  ["ATTACK: pump buy amount changed", [limit(180_000), pumpBuy({ amount: BigInt(2_000_000), max: BigInt(110_000) }), memo], false],
  ["ATTACK: pump buy for a different wallet", [limit(180_000), pumpBuy({ user: thief, max: BigInt(110_000) }), memo], false],
  ["ATTACK: pump buy flags changed", [limit(180_000), pumpBuy({ max: BigInt(110_000), tail: 0 }), memo], false],
  ["ATTACK: pump buy memo dropped", [limit(180_000), pumpBuy({ max: BigInt(110_000) })], false],
];

const original = [limit(100), swap({}), feeTransfer, memo];

const cases: [string, TransactionInstruction[], PublicKey, boolean][] = [
  ["compute budget resized, fee added", [limit(180_000), price(20_000), swap({}), feeTransfer, memo], payer, true],
  ["compute budget removed entirely", [swap({}), feeTransfer, memo], payer, true],
  ["swap re-quoted: same trade, new route and quote", [limit(180_000), swap({ quoted: BigInt(4_700_000), route: 9 }), feeTransfer, memo], payer, true],
  ["swap re-quoted with token-account setup in front", [limit(180_000), ataCreate, swap({ quoted: BigInt(4_700_000), route: 9 }), feeTransfer, memo], payer, true],
  ["swap re-quoted into a different Jupiter layout, same receiver", [limit(180_000), sharedSwap({}), feeTransfer, memo], payer, true],
  ["ATTACK: different layout used to redirect the proceeds", [limit(180_000), sharedSwap({ receiver: thief }), feeTransfer, memo], payer, false],
  ["ATTACK: extra transfer to a stranger appended", [limit(180_000), swap({}), feeTransfer, memo, SystemProgram.transfer({ fromPubkey: payer, toPubkey: thief, lamports: 9_000_000 })], payer, false],
  ["ATTACK: fee transfer redirected to a stranger", [limit(180_000), swap({}), SystemProgram.transfer({ fromPubkey: payer, toPubkey: thief, lamports: 5000 }), memo], payer, false],
  ["ATTACK: fee transfer amount raised", [limit(180_000), swap({}), SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 5_000_000 }), memo], payer, false],
  ["ATTACK: memo dropped", [limit(180_000), swap({}), feeTransfer], payer, false],
  ["ATTACK: instructions reordered", [limit(180_000), swap({}), memo, feeTransfer], payer, false],
  ["ATTACK: fee payer swapped", [limit(180_000), swap({}), feeTransfer, memo], thief, false],
  ["ATTACK: new required signer slipped in", [limit(180_000), swap({}), feeTransfer, memo, new TransactionInstruction({ programId: ATA, keys: [{ pubkey: thief, isSigner: true, isWritable: true }], data: Buffer.from([1]) })], payer, false],
  ["ATTACK: swap amount raised", [limit(180_000), swap({ amount: BigInt(900_000_000) }), feeTransfer, memo], payer, false],
  ["ATTACK: slippage tolerance widened", [limit(180_000), swap({ slippage: 5000 }), feeTransfer, memo], payer, false],
  ["ATTACK: output token changed", [limit(180_000), swap({ out: thief }), feeTransfer, memo], payer, false],
  ["ATTACK: swap executed for a different wallet", [limit(180_000), swap({ user: thief }), feeTransfer, memo], payer, false],
  ["ATTACK: swap proceeds redirected to a stranger's token account", [limit(180_000), swap({ receiver: thief }), feeTransfer, memo], payer, false],
  ["ATTACK: proceeds redirected through the optional destination slot", [limit(180_000), swap({ altReceiver: thief }), feeTransfer, memo], payer, false],
  ["ATTACK: input pulled from a different token account", [limit(180_000), swap({ source: thief }), feeTransfer, memo], payer, false],
  ["ATTACK: swap replaced by an arbitrary program call", [limit(180_000), new TransactionInstruction({ programId: thief, keys: [], data: Buffer.from([1, 2, 3]) }), feeTransfer, memo], payer, false],
];

let pass = 0;
for (const [name, repaired, repairedPayer, expectOk] of cases) {
  const v = verifyInstructions({ payer, instructions: original }, { payer: repairedPayer, instructions: repaired });
  const ok = v.ok === expectOk;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      -> ${v.ok ? `accepted (${v.kept} kept, ${v.changes.length} declared changes)` : `refused: ${v.violations[0]}`}`);
}
for (const [name, repaired, expectOk] of directCases) {
  const v = verifyInstructions({ payer, instructions: pumpOriginal }, { payer, instructions: repaired });
  const ok = v.ok === expectOk;
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      -> ${v.ok ? `accepted (${v.kept} kept, ${v.changes.map((c) => c.kind).join(",")})` : `refused: ${v.violations[0]}`}`);
}
const total = cases.length + directCases.length;
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
