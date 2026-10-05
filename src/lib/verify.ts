import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DIRECT_LAYOUTS, isAllowedDirectLimitChange, isAllowedQuoteMove, readDirectSwapShape, readSwapShape, isAllowedWrapRaise, readSystemTransfer } from "./swap-shape";

/**
 * Verify a repair without trusting the service that made it.
 *
 * A repaired transaction is only allowed to differ from the original in three ways:
 *   1. ComputeBudget instructions may be added, removed or changed (limit, price, data size).
 *   2. One Jupiter swap instruction may be replaced by another Jupiter swap instruction for the
 *      SAME user, SAME source and destination token accounts, SAME output token, SAME amount
 *      and SAME slippage tolerance, optionally
 *      preceded by idempotent token-account creation.
 *   3. One Pump.fun or PumpSwap swap may have ONLY its limit (max cost / min output) moved, by at
 *      most 25% against the user; amount, accounts and flags identical.
 *   4. The recent blockhash (not an instruction, so not checked here).
 *
 * Everything else must be identical and in the same order: same fee payer, same set of
 * signers, and every other instruction byte for byte. This file has no network access and
 * no dependency on the TxWhy service. The server runs it on its own output and refuses to
 * return anything that fails.
 */

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export interface InstructionChange {
  kind: "kept" | "compute_budget" | "swap_replaced" | "token_account_setup" | "swap_limit_moved" | "wrap_raised";
  program: string;
  detail: string;
}

export interface Verification {
  ok: boolean;
  /** Human-readable reasons the repair is NOT acceptable. Empty when ok. */
  violations: string[];
  kept: number;
  changes: InstructionChange[];
}

const id = (k: PublicKey) => k.toBase58();

function sameInstruction(a: TransactionInstruction, b: TransactionInstruction): boolean {
  if (id(a.programId) !== id(b.programId)) return false;
  if (a.keys.length !== b.keys.length) return false;
  for (let i = 0; i < a.keys.length; i++) if (id(a.keys[i].pubkey) !== id(b.keys[i].pubkey)) return false;
  return Buffer.from(a.data).equals(Buffer.from(b.data));
}

function signerSet(payer: PublicKey, instructions: TransactionInstruction[]): Set<string> {
  const out = new Set<string>([id(payer)]);
  for (const ix of instructions) for (const k of ix.keys) if (k.isSigner) out.add(id(k.pubkey));
  return out;
}

const isComputeBudget = (ix: TransactionInstruction) => id(ix.programId) === COMPUTE_BUDGET;
/** Associated Token Account "CreateIdempotent" (tag 1): harmless if the account already exists. */
const isIdempotentAtaCreate = (ix: TransactionInstruction) => id(ix.programId) === ATA_PROGRAM && ix.data[0] === 1;

function describeBudget(ix: TransactionInstruction): string {
  const data = Buffer.from(ix.data);
  switch (data[0]) {
    case 2:
      return `compute unit limit ${data.readUInt32LE(1).toLocaleString("en-US")}`;
    case 3:
      return `priority fee ${data.readBigUInt64LE(1).toString()} micro-lamports per compute unit`;
    case 4:
      return `loaded account data limit ${data.readUInt32LE(1).toLocaleString("en-US")} bytes`;
    case 1:
      return `heap frame ${data.readUInt32LE(1).toLocaleString("en-US")} bytes`;
    default:
      return "compute budget setting";
  }
}

export function verifyInstructions(
  original: { payer: PublicKey; instructions: TransactionInstruction[] },
  repaired: { payer: PublicKey; instructions: TransactionInstruction[] },
): Verification {
  const violations: string[] = [];
  const changes: InstructionChange[] = [];
  let kept = 0;

  if (id(original.payer) !== id(repaired.payer)) {
    violations.push(`The fee payer changed from ${id(original.payer)} to ${id(repaired.payer)}.`);
  }
  const before = signerSet(original.payer, original.instructions);
  const after = signerSet(repaired.payer, repaired.instructions);
  for (const s of after) if (!before.has(s)) violations.push(`A new required signer was added: ${s}.`);
  for (const s of before) if (!after.has(s)) violations.push(`A required signer was removed: ${s}.`);

  for (const ix of repaired.instructions) {
    if (isComputeBudget(ix)) changes.push({ kind: "compute_budget", program: "Compute Budget", detail: describeBudget(ix) });
  }

  const a = original.instructions.filter((ix) => !isComputeBudget(ix));
  const b = repaired.instructions.filter((ix) => !isComputeBudget(ix));
  let i = 0;
  let j = 0;
  /** A SOL transfer that was raised and still has to be justified by the swap it funds. */
  let pendingWrap: { to: string; before: bigint; after: bigint } | null = null;
  while (i < a.length && j < b.length) {
    if (sameInstruction(a[i], b[j])) {
      kept++;
      i++;
      j++;
      continue;
    }
    const wasTransfer = readSystemTransfer(a[i]);
    const nowTransfer = readSystemTransfer(b[j]);
    if (!pendingWrap && wasTransfer && nowTransfer && wasTransfer.from === nowTransfer.from && wasTransfer.to === nowTransfer.to && nowTransfer.lamports > wasTransfer.lamports) {
      // Tentatively allowed: accepted only if the direct swap that follows spends from this account and its maximum rose at least as much.
      pendingWrap = { to: wasTransfer.to, before: wasTransfer.lamports, after: nowTransfer.lamports };
      i++;
      j++;
      continue;
    }
    if (id(a[i].programId) === JUPITER_V6) {
      // Allowed: [idempotent token-account creation]* followed by one equivalent Jupiter swap.
      let k = j;
      while (k < b.length && isIdempotentAtaCreate(b[k])) k++;
      const candidate = b[k];
      const was = readSwapShape(a[i]);
      const now = candidate && id(candidate.programId) === JUPITER_V6 ? readSwapShape(candidate) : null;
      if (!was || !now) {
        violations.push(`Instruction ${i + 1} (a Jupiter swap) was changed into something that is not an equivalent swap.`);
        break;
      }
      const mismatches = [
        was.user !== now.user && "the swapping wallet",
        was.outputMint !== now.outputMint && "the output token",
        was.mode !== now.mode && "the swap mode",
        was.amount !== now.amount && "the amount",
        was.slippageBps !== now.slippageBps && "the slippage tolerance",
        !isAllowedQuoteMove(was.mode, was.quotedOther, now.quotedOther) && `the quoted ${was.mode === "ExactIn" ? "output" : "cost"}, by more than 25% against the user`,
        was.source !== now.source && "the token account the input is taken from",
        (!was.receiver || was.receiver !== now.receiver) && "the token account that receives the output",
      ].filter(Boolean);
      if (mismatches.length > 0) {
        violations.push(`The replacement swap changes ${mismatches.join(", ")}.`);
        break;
      }
      for (let s = j; s < k; s++) {
        changes.push({ kind: "token_account_setup", program: "Associated Token Account", detail: "create token account if missing (idempotent)" });
      }
      changes.push({
        kind: "swap_replaced",
        program: "Jupiter Aggregator v6",
        detail: `same wallet, output token, amount and ${(was.slippageBps / 100).toFixed(2)}% tolerance; new route and quote`,
      });
      i++;
      j = k + 1;
      continue;
    }
    if (DIRECT_LAYOUTS[id(a[i].programId)] && id(b[j].programId) === id(a[i].programId)) {
      // Allowed: the same Pump.fun / PumpSwap swap with only its limit moved, within the cap.
      const was = readDirectSwapShape(a[i]);
      const now = readDirectSwapShape(b[j]);
      const verdict = isAllowedDirectLimitChange(was, now);
      if (!verdict.ok || !was || !now) {
        violations.push(`The replacement ${was?.program ?? "swap"} instruction changes ${verdict.reason ?? "the swap"}.`);
        break;
      }
      if (pendingWrap) {
        const input = was.userIn != null ? a[i].keys[was.userIn]?.pubkey.toBase58() : undefined;
        if (was.limit !== "max_in" || input !== pendingWrap.to || !isAllowedWrapRaise(pendingWrap.before, pendingWrap.after, was.limitValue, now.limitValue)) {
          violations.push(`A SOL transfer to ${pendingWrap.to} was raised from ${pendingWrap.before} to ${pendingWrap.after} lamports, which the limit move of this swap does not justify.`);
          break;
        }
        changes.push({ kind: "wrap_raised", program: "System Program", detail: `SOL wrapped into the input account of the swap ${pendingWrap.before} -> ${pendingWrap.after} lamports, no more than the maximum cost rose` });
        pendingWrap = null;
      }
      changes.push({
        kind: "swap_limit_moved",
        program: was.program,
        detail: `same ${was.name}, same amount and accounts; ${was.limit === "max_in" ? "maximum cost" : "minimum received"} ${was.limitValue} -> ${now.limitValue}`,
      });
      i++;
      j++;
      continue;
    }
    violations.push(`Instruction ${i + 1} (program ${id(a[i].programId)}) is not the same in the repaired transaction.`);
    break;
  }
  if (violations.length === 0 && pendingWrap) {
    violations.push(`A SOL transfer to ${pendingWrap.to} was raised from ${pendingWrap.before} to ${pendingWrap.after} lamports with no swap limit move to justify it.`);
  }
  if (violations.length === 0) {
    if (i < a.length) violations.push(`${a.length - i} original instruction(s) are missing from the repaired transaction.`);
    if (j < b.length) violations.push(`The repaired transaction contains ${b.length - j} instruction(s) that were not in the original (first: program ${id(b[j].programId)}).`);
  }

  return { ok: violations.length === 0, violations, kept, changes };
}
