import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodeTransactionError } from "./errors";
import { fetchIdlErrors } from "./idl";
import { rpc } from "./rpc";
import { getTrace } from "./trace";
import type { DecodedError } from "./types";

/**
 * Repair engine v1.
 *
 * Input: a failed signature OR a serialized (unsigned or signed) transaction.
 * Output: the cause, and — when the failure is mechanically fixable — a rebuilt
 * UNSIGNED transaction that has been re-simulated against live state to prove
 * it passes. The caller signs and sends. Keys never touch this service.
 *
 * Repairs applied in v1: fresh blockhash, compute-unit limit sized from a real
 * simulation, priority fee from recent on-chain fees. Failures that need funds,
 * a new quote, or a human decision are reported honestly, not papered over.
 */

const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
const MAX_CU = 1_400_000;
const CU_HEADROOM = 1.15;
const FEE_FLOOR = 1_000; // micro-lamports per CU
const FEE_CEILING = 2_000_000;

export type RepairStatus = "repaired" | "valid" | "needs_requote" | "not_repairable";

export interface RepairChange {
  type: "blockhash" | "compute_unit_limit" | "priority_fee";
  before: string;
  after: string;
  reason: string;
}

export interface SimulationProof {
  passed: boolean;
  unitsConsumed: number | null;
  error: DecodedError | null;
  logsTail: string[];
}

export interface RepairResult {
  status: RepairStatus;
  summary: string;
  /** What was wrong with the transaction as submitted. Null when it was already valid. */
  cause: DecodedError | null;
  changes: RepairChange[];
  /** Base64, unsigned. Present when status is "repaired" or "valid". */
  repairedTransaction: string | null;
  /** Simulation of the transaction exactly as returned. */
  simulation: SimulationProof;
  notes: string[];
}

interface SimValue {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
}

function innermostFailedProgram(logs: string[]): string | null {
  for (const line of logs) {
    const m = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/);
    if (m) return m[1];
  }
  return null;
}

async function decodeSimError(err: unknown, logs: string[]): Promise<DecodedError | null> {
  if (err == null) return null;
  const programId = innermostFailedProgram(logs);
  const idlErrors = programId ? await fetchIdlErrors(programId) : null;
  return decodeTransactionError(err, programId, logs, idlErrors);
}

async function simulate(tx: VersionedTransaction): Promise<SimValue> {
  const encoded = Buffer.from(tx.serialize()).toString("base64");
  const { value } = await rpc<{ value: SimValue }>("simulateTransaction", [
    encoded,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" },
  ]);
  return value;
}

async function loadLookupTables(tx: VersionedTransaction): Promise<AddressLookupTableAccount[]> {
  const lookups = tx.message.addressTableLookups ?? [];
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of lookups) {
    const { value } = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
      lookup.accountKey.toBase58(),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!value) {
      throw new RepairInputError(
        `Address lookup table ${lookup.accountKey.toBase58()} no longer exists, so this transaction cannot be rebuilt.`,
      );
    }
    tables.push(
      new AddressLookupTableAccount({
        key: lookup.accountKey,
        state: AddressLookupTableAccount.deserialize(Buffer.from(value.data[0], "base64")),
      }),
    );
  }
  return tables;
}

export class RepairInputError extends Error {}
/** The transaction format is newer than the rebuild path understands. Diagnosis still works. */
class UnsupportedVersionError extends Error {}

/** Fetch a confirmed transaction's raw bytes by signature. */
async function fetchRawTransaction(signature: string): Promise<VersionedTransaction> {
  const result = await rpc<{ transaction: [string, string] } | null>("getTransaction", [
    signature,
    { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" },
  ]);
  if (!result) {
    throw new RepairInputError(
      "Transaction not found. It may be older than the RPC's history or on a different cluster.",
    );
  }
  try {
    return VersionedTransaction.deserialize(Buffer.from(result.transaction[0], "base64"));
  } catch {
    throw new UnsupportedVersionError();
  }
}

function parseTransaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(base64.trim(), "base64"));
  } catch {
    throw new RepairInputError("Could not decode that as a base64 Solana transaction.");
  }
}

interface BudgetInfo {
  limit: number | null;
  price: bigint | null;
  /** Compute-budget instructions we keep untouched (heap frame, loaded-data size). */
  kept: TransactionInstruction[];
  rest: TransactionInstruction[];
}

function splitComputeBudget(instructions: TransactionInstruction[]): BudgetInfo {
  const info: BudgetInfo = { limit: null, price: null, kept: [], rest: [] };
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_ID) {
      info.rest.push(ix);
      continue;
    }
    const tag = ix.data[0];
    if (tag === 2 && ix.data.length >= 5) info.limit = ix.data.readUInt32LE(1);
    else if (tag === 3 && ix.data.length >= 9) info.price = ix.data.readBigUInt64LE(1);
    else info.kept.push(ix);
  }
  return info;
}

async function recentPriorityFee(writable: PublicKey[]): Promise<number> {
  try {
    const fees = await rpc<{ prioritizationFee: number }[]>("getRecentPrioritizationFees", [
      writable.slice(0, 128).map((k) => k.toBase58()),
    ]);
    const nonZero = fees.map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (nonZero.length === 0) return FEE_FLOOR;
    const p75 = nonZero[Math.floor(nonZero.length * 0.75)] ?? nonZero[nonZero.length - 1];
    return Math.min(FEE_CEILING, Math.max(FEE_FLOOR, p75));
  } catch {
    return FEE_FLOOR;
  }
}

function build(
  payerKey: PublicKey,
  blockhash: string,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[],
  legacy: boolean,
): VersionedTransaction {
  const message = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions });
  try {
    return new VersionedTransaction(
      legacy ? message.compileToLegacyMessage() : message.compileToV0Message(tables),
    );
  } catch (e) {
    throw new RepairInputError(
      `The rebuilt transaction does not fit Solana's size limit (${e instanceof Error ? e.message : "too large"}).`,
    );
  }
}

const SLIPPAGE_PATTERN = /slippage|SlippageToleranceExceeded|ExceededSlippage|TooLittleOutput|price impact/i;

function classifyUnrepairable(
  cause: DecodedError,
  logs: string[],
): { status: RepairStatus; notes: string[]; cause?: DecodedError } {
  const haystack = `${cause.title} ${cause.code ?? ""} ${cause.cause} ${logs.join(" ")}`;
  if (SLIPPAGE_PATTERN.test(haystack)) {
    return {
      status: "needs_requote",
      notes: [
        "The price moved past the slippage tolerance baked into this transaction. The swap amounts are inside the instruction data, so it must be rebuilt from a fresh quote. Request a new quote and route, then send within a few seconds.",
      ],
    };
  }
  const lamports = logs.join("\n").match(/insufficient lamports (\d+), need (\d+)/);
  if (lamports) {
    const have = Number(lamports[1]);
    const need = Number(lamports[2]);
    return {
      status: "not_repairable",
      cause: {
        title: "Insufficient SOL",
        code: cause.code,
        cause: "A transfer inside this transaction moves more lamports than the source account holds.",
        fix: "Fund the source account or lower the amount, then resend.",
      },
      notes: [
        `The paying account holds ${have} lamports and needs ${need}. Shortfall: ${need - have} lamports (${((need - have) / 1e9).toFixed(6)} SOL). Fund the account, then resend.`,
      ],
    };
  }
  return { status: "not_repairable", notes: [] };
}

export interface RepairInput {
  signature?: string;
  transaction?: string;
}

export async function repair(input: RepairInput): Promise<RepairResult> {
  if (!input.signature && !input.transaction) {
    throw new RepairInputError('Provide either "signature" or "transaction" (base64).');
  }
  // For a signature, the truth about WHY it failed is the on-chain record, not a re-simulation.
  const onchain = input.transaction ? null : await getTrace(input.signature as string);
  if (!input.transaction && !onchain) {
    throw new RepairInputError(
      "Transaction not found. It may be older than the RPC's history or on a different cluster.",
    );
  }
  if (onchain?.success) {
    return {
      status: "valid",
      summary: "This transaction succeeded on chain. There is nothing to repair.",
      cause: null,
      changes: [],
      repairedTransaction: null,
      simulation: { passed: true, unitsConsumed: null, error: null, logsTail: [] },
      notes: [],
    };
  }

  let original: VersionedTransaction;
  try {
    original = input.transaction
      ? parseTransaction(input.transaction)
      : await fetchRawTransaction(input.signature as string);
  } catch (e) {
    if (!(e instanceof UnsupportedVersionError)) throw e;
    return {
      status: "not_repairable",
      summary:
        "Diagnosed, but not rebuilt: this is a version 1 transaction, a format the rebuild path does not support yet.",
      cause: onchain?.error ?? null,
      changes: [],
      repairedTransaction: null,
      simulation: { passed: false, unitsConsumed: null, error: onchain?.error ?? null, logsTail: (onchain?.logs ?? []).slice(-8) },
      notes: ["Apply the fix above when you rebuild the transaction in your own client."],
    };
  }
  const landed = onchain != null;

  const legacy = original.version === "legacy";
  const tables = await loadLookupTables(original);
  const decompiled = TransactionMessage.decompile(original.message, {
    addressLookupTableAccounts: tables,
  });
  const budget = splitComputeBudget(decompiled.instructions);
  const notes: string[] = [];
  const changes: RepairChange[] = [];

  // 1. Was the submitted blockhash still usable?
  const originalBlockhash = decompiled.recentBlockhash;
  const { value: blockhashValid } = await rpc<{ value: boolean }>("isBlockhashValid", [
    originalBlockhash,
    { commitment: "confirmed" },
  ]);
  const { value: latest } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);

  // 2. Simulate the transaction AS SUBMITTED (only the blockhash refreshed, otherwise
  //    an expired blockhash would mask every other problem).
  const asSubmitted = build(decompiled.payerKey, latest.blockhash, decompiled.instructions, tables, legacy);
  const submittedSim = await simulate(asSubmitted);
  let cause = onchain?.error ?? (await decodeSimError(submittedSim.err, submittedSim.logs ?? []));
  if (landed) {
    changes.push({
      type: "blockhash",
      before: originalBlockhash,
      after: latest.blockhash,
      reason: "The original transaction already landed and failed. Resending it requires a new blockhash.",
    });
  } else if (!blockhashValid) {
    const expired: DecodedError = {
      title: "Blockhash expired",
      code: "BlockhashNotFound",
      cause:
        "The recent blockhash in this transaction is no longer valid. Too much time passed between building and landing it (a blockhash lives roughly 60 to 90 seconds).",
      fix: "Rebuild with a fresh blockhash immediately before signing and sending.",
    };
    cause = cause ?? expired;
    changes.push({
      type: "blockhash",
      before: originalBlockhash,
      after: latest.blockhash,
      reason: "The original blockhash had expired.",
    });
  }

  // 3. Probe with the maximum compute budget to learn what the transaction really needs
  //    and whether anything other than the budget is wrong.
  const probe = build(
    decompiled.payerKey,
    latest.blockhash,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept, ...budget.rest],
    tables,
    legacy,
  );
  const probeSim = await simulate(probe);

  if (probeSim.err != null) {
    const probeCause = (await decodeSimError(probeSim.err, probeSim.logs ?? [])) ?? cause;
    const verdict = classifyUnrepairable(
      probeCause ?? { title: "Unknown failure", cause: "", fix: "" },
      probeSim.logs ?? [],
    );
    if (landed && onchain?.error && probeCause && onchain.error.title !== probeCause.title) {
      notes.push(
        `On chain it failed with "${onchain.error.title}". Against current state it now fails with "${probeCause.title}".`,
      );
    }
    return {
      status: verdict.status,
      summary:
        verdict.status === "needs_requote"
          ? "This transaction fails on slippage and needs a fresh quote. A blockhash or fee change cannot fix it."
          : "This transaction fails for a reason that cannot be fixed by rebuilding it.",
      cause: verdict.cause ?? probeCause,
      changes: [],
      repairedTransaction: null,
      simulation: {
        passed: false,
        unitsConsumed: probeSim.unitsConsumed ?? null,
        error: verdict.cause ?? probeCause,
        logsTail: (probeSim.logs ?? []).slice(-12),
      },
      notes: [...verdict.notes, ...notes],
    };
  }

  // 4. Size the compute-unit limit from the real measurement.
  const measured = probeSim.unitsConsumed ?? 0;
  const newLimit = Math.min(MAX_CU, Math.ceil((measured + 150) * CU_HEADROOM)); // +150: the price instruction added below
  if (budget.limit == null || budget.limit < measured || budget.limit > newLimit * 3) {
    changes.push({
      type: "compute_unit_limit",
      before: budget.limit == null ? "not set (default 200,000 per instruction)" : String(budget.limit),
      after: String(newLimit),
      reason:
        budget.limit != null && budget.limit < measured
          ? `The transaction needs ${measured} compute units but its limit was ${budget.limit}.`
          : `Sized to measured usage (${measured} units) plus 15% headroom. A tight limit lowers the fee and improves scheduling.`,
    });
  }
  const limit = changes.some((c) => c.type === "compute_unit_limit") ? newLimit : (budget.limit as number);

  // 5. Priority fee from what the network is actually charging for these accounts.
  const writable = original.message
    .getAccountKeys({ addressLookupTableAccounts: tables })
    .keySegments()
    .flat()
    .filter((_, i) => original.message.isAccountWritable(i));
  const marketFee = await recentPriorityFee(writable);
  const currentFee = budget.price == null ? 0 : Number(budget.price);
  let fee = currentFee;
  if (currentFee < marketFee) {
    fee = marketFee;
    changes.push({
      type: "priority_fee",
      before: currentFee === 0 ? "none" : `${currentFee} micro-lamports per CU`,
      after: `${marketFee} micro-lamports per CU`,
      reason:
        "Below the 75th percentile recently paid for these accounts, so the transaction was likely to be dropped or delayed under load.",
    });
  }

  // 6. Build the final transaction and prove it.
  const finalTx = build(
    decompiled.payerKey,
    latest.blockhash,
    [
      ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
      ...budget.kept,
      ...budget.rest,
    ],
    tables,
    legacy,
  );
  const finalSim = await simulate(finalTx);
  const finalError = await decodeSimError(finalSim.err, finalSim.logs ?? []);
  const passed = finalSim.err == null;

  if (!changes.some((c) => c.type === "blockhash")) {
    notes.push("A fresh blockhash is always applied, so sign and send within about 60 seconds.");
  }
  notes.push(
    "Simulation runs against current chain state. It proves the transaction executes now. It cannot guarantee inclusion if state changes before it lands.",
  );

  const wasBroken = cause != null;
  const budgetFixed = changes.some((c) => c.type === "compute_unit_limit" && /needs \d+ compute units/.test(c.reason));
  if (passed && landed && !budgetFixed) {
    notes.unshift(
      "The original failure depended on chain state at that moment (price, liquidity or account state). That condition no longer holds, which is why the same instructions pass now. Confirm the amounts are still what you want before signing.",
    );
  }
  return {
    status: passed ? (wasBroken ? "repaired" : "valid") : "not_repairable",
    summary: !passed
      ? "The rebuilt transaction still fails simulation."
      : wasBroken
        ? landed
          ? `On chain this failed with "${cause?.title}". Rebuilt against current state, it passes simulation.`
          : `Repaired. ${changes.length} change${changes.length === 1 ? "" : "s"} applied and the rebuilt transaction passes simulation.`
        : changes.length > 0
          ? "The transaction already executes. Returned an optimised version that is more likely to land."
          : "The transaction already executes and needs no changes.",
    cause,
    changes,
    repairedTransaction: passed ? Buffer.from(finalTx.serialize()).toString("base64") : null,
    simulation: {
      passed,
      unitsConsumed: finalSim.unitsConsumed ?? null,
      error: finalError,
      logsTail: (finalSim.logs ?? []).slice(-8),
    },
    notes,
  };
}
