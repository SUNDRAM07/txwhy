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
import { requoteJupiter } from "./requote";
import { rpc } from "./rpc";
import { getTrace } from "./trace";
import { type Verification, verifyInstructions } from "./verify";
import type { DecodedError } from "./types";

/**
 * Repair engine v1.
 *
 * Input: a failed signature OR a serialized (unsigned or signed) transaction.
 * Output: the cause, and — when the failure is mechanically fixable — a rebuilt
 * UNSIGNED transaction that has been re-simulated against live state to prove
 * it passes. The caller signs and sends. Keys never touch this service.
 *
 * Repairs: fresh blockhash, compute-unit limit sized from a real simulation,
 * priority fee from recent on-chain fees, and a fresh route for plain Jupiter
 * swaps that failed on slippage. Failures that need funds,
 * a new quote, or a human decision are reported honestly, not papered over.
 */

const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
const MAX_CU = 1_400_000;
const CU_HEADROOM = 1.15;
const FEE_FLOOR = 1_000; // micro-lamports per CU
const FEE_CEILING = 2_000_000;
/** Never raise the total priority fee above this on someone's behalf (0.001 SOL). */
const MAX_PRIORITY_LAMPORTS = 1_000_000;

export type RepairStatus = "repaired" | "valid" | "needs_requote" | "not_repairable";

export interface RepairChange {
  type: "blockhash" | "compute_unit_limit" | "priority_fee" | "swap_quote" | "loaded_accounts_data_limit";
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
  /**
   * Instruction-level proof of what changed. Present whenever a transaction is returned.
   * The same check is published as verifyInstructions() so callers can run it themselves.
   */
  verification?: Verification;
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
  const addresses = (tx.message.addressTableLookups ?? []).map((l) => l.accountKey.toBase58());
  const tables = await loadTablesByAddress(addresses);
  if (tables.length !== addresses.length) {
    const missing = addresses.find((a) => !tables.some((t) => t.key.toBase58() === a));
    throw new RepairInputError(`Address lookup table ${missing} no longer exists, so this transaction cannot be rebuilt.`);
  }
  return tables;
}

async function loadTablesByAddress(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];
  const { value } = await rpc<{ value: ({ data: [string, string] } | null)[] }>("getMultipleAccounts", [
    addresses,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  const out: AddressLookupTableAccount[] = [];
  value.forEach((acc, i) => {
    if (!acc) return;
    out.push(
      new AddressLookupTableAccount({
        key: new PublicKey(addresses[i]),
        state: AddressLookupTableAccount.deserialize(Buffer.from(acc.data[0], "base64")),
      }),
    );
  });
  return out;
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

/** ComputeBudget tag 4: SetLoadedAccountsDataSizeLimit. */
const isLoadedDataLimit = (ix: TransactionInstruction) =>
  ix.programId.toBase58() === COMPUTE_BUDGET_ID && ix.data[0] === 4;
const hitLoadedDataLimit = (err: unknown) => JSON.stringify(err ?? "").includes("MaxLoadedAccountsDataSizeExceeded");

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

  let legacy = original.version === "legacy";
  let tables = await loadLookupTables(original);
  const decompiled = TransactionMessage.decompile(original.message, {
    addressLookupTableAccounts: tables,
  });
  const budget = splitComputeBudget(decompiled.instructions);
  const notes: string[] = [];
  const changes: RepairChange[] = [];

  // 1. Was the submitted blockhash still usable?
  const originalBlockhash = decompiled.recentBlockhash;
  const [{ value: blockhashValid }, { value: latest }] = await Promise.all([
    rpc<{ value: boolean }>("isBlockhashValid", [originalBlockhash, { commitment: "confirmed" }]),
    rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);

  // 2. Simulate the transaction AS SUBMITTED (only the blockhash refreshed, otherwise
  //    an expired blockhash would mask every other problem).
  const asSubmitted = build(decompiled.payerKey, latest.blockhash, decompiled.instructions, tables, legacy);
  // The as-submitted run and the maximum-budget probe (step 3) are independent, so they run together.
  const probe = build(
    decompiled.payerKey,
    latest.blockhash,
    [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept, ...budget.rest],
    tables,
    legacy,
  );
  const [submittedSim, firstProbeSim] = await Promise.all([simulate(asSubmitted), simulate(probe)]);
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
  let probeSim = firstProbeSim;
  let requoted = false;
  /** Set when the swap can never be repaired, so we say that instead of "get a fresh quote". */
  let finalVerdict: string | null = null;

  const liftLoadedDataLimit = (reason: string) => {
    const declared = budget.kept.find(isLoadedDataLimit);
    if (!declared) return false;
    budget.kept = budget.kept.filter((ix) => !isLoadedDataLimit(ix));
    changes.push({
      type: "loaded_accounts_data_limit",
      before: `${declared.data.readUInt32LE(1).toLocaleString("en-US")} bytes`,
      after: "runtime default (64 MB)",
      reason,
    });
    return true;
  };
  if (hitLoadedDataLimit(probeSim.err) && liftLoadedDataLimit("The transaction loads more account data than the limit it declared for itself.")) {
    probeSim = await simulate(
      build(
        decompiled.payerKey,
        latest.blockhash,
        [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept, ...budget.rest],
        tables,
        legacy,
      ),
    );
  }

  if (probeSim.err != null) {
    const probeCause = (await decodeSimError(probeSim.err, probeSim.logs ?? [])) ?? cause;
    const verdict = classifyUnrepairable(
      probeCause ?? { title: "Unknown failure", cause: "", fix: "" },
      probeSim.logs ?? [],
    );
    if (landed && onchain?.error && probeCause && onchain.error.title !== probeCause.title) {
      notes.push(
        `Replayed against current state, the original instructions now stop at "${probeCause.title}". That is expected for an old transaction: its route and quote are stale.`,
      );
    }
    // Slippage: the amounts are inside the instruction, so rebuild the swap from a fresh quote.
    // A landed swap that failed on slippage needs a fresh quote whatever its stale route does today.
    const failedOnSlippage = onchain?.error != null && SLIPPAGE_PATTERN.test(`${onchain.error.title} ${onchain.error.code ?? ""}`);
    const wantsRequote = verdict.status === "needs_requote" || failedOnSlippage;
    if (wantsRequote) {
      const requote = await requoteJupiter(budget.rest);
      if (requote.ok) {
        try {
          const extra = await loadTablesByAddress(requote.lookupTables.filter((a) => !tables.some((t) => t.key.toBase58() === a)));
          const mergedTables = [...tables, ...extra];
          const needsV0 = legacy && mergedTables.length > 0;
          const reprobe = build(
            decompiled.payerKey,
            latest.blockhash,
            [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept, ...requote.instructions],
            mergedTables,
            legacy && !needsV0,
          );
          let reprobeSim = await simulate(reprobe);
          if (
            hitLoadedDataLimit(reprobeSim.err) &&
            liftLoadedDataLimit("The fresh route loads different accounts than the limit the original transaction declared.")
          ) {
            reprobeSim = await simulate(
              build(
                decompiled.payerKey,
                latest.blockhash,
                [ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept, ...requote.instructions],
                mergedTables,
                legacy && !needsV0,
              ),
            );
          }
          if (reprobeSim.err == null) {
            // Adopt the spliced instructions and carry on through sizing, fee and final proof.
            budget.rest = requote.instructions;
            tables = mergedTables;
            if (needsV0) legacy = false;
            probeSim = reprobeSim;
            requoted = true;
            cause = cause ?? verdict.cause ?? probeCause;
            changes.push({
              type: "swap_quote",
              before: requote.before,
              after: requote.after,
              reason:
                "The price moved past the tolerance in the original swap, so that one instruction was rebuilt from a current quote.",
            });
            notes.push(...requote.notes, "Quotes go stale within seconds. Sign and send immediately.");
          } else {
            const again = await decodeSimError(reprobeSim.err, reprobeSim.logs ?? []);
            notes.push(
              `A fresh quote was spliced in but the transaction still fails simulation (${again?.title ?? "unknown error"}), so it is not returned.`,
            );
          }
        } catch (e) {
          notes.push(e instanceof Error ? e.message : "The re-quoted transaction could not be assembled.");
        }
      } else if (requote.final) {
        finalVerdict = requote.reason;
      } else {
        notes.push(requote.reason);
      }
    }

    if (!requoted && finalVerdict) {
      const base = landed ? (onchain?.error ?? verdict.cause ?? probeCause) : (verdict.cause ?? probeCause);
      return {
        status: "not_repairable",
        summary: finalVerdict,
        cause: base ? { ...base, fix: "Nothing to fix. This transaction did what it was designed to do when the opportunity was gone." } : null,
        changes: [],
        repairedTransaction: null,
        simulation: {
          passed: false,
          unitsConsumed: probeSim.unitsConsumed ?? null,
          error: probeCause,
          logsTail: (probeSim.logs ?? []).slice(-12),
        },
        notes: [],
      };
    }
    if (!requoted) return {
      status: wantsRequote ? "needs_requote" : verdict.status,
      summary:
        wantsRequote
          ? "This transaction fails on slippage and needs a fresh quote. A blockhash or fee change cannot fix it."
          : "This transaction fails for a reason that cannot be fixed by rebuilding it.",
      cause: landed ? (onchain?.error ?? verdict.cause ?? probeCause) : (verdict.cause ?? probeCause),
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
  const writableSet = new Map<string, PublicKey>([[decompiled.payerKey.toBase58(), decompiled.payerKey]]);
  for (const ix of budget.rest) {
    for (const k of ix.keys) if (k.isWritable) writableSet.set(k.pubkey.toBase58(), k.pubkey);
  }
  const writable = [...writableSet.values()];
  const affordableRate = Math.floor((MAX_PRIORITY_LAMPORTS * 1_000_000) / Math.max(limit, 1));
  const marketFee = Math.min(await recentPriorityFee(writable), affordableRate);
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
  let finalInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
    ...budget.kept,
    ...budget.rest,
  ];
  const finalTx = build(decompiled.payerKey, latest.blockhash, finalInstructions, tables, legacy);
  let finalSim = await simulate(finalTx);
  let returned = finalTx;
  if (finalSim.err != null && fee !== currentFee) {
    // The raised fee may be more than the wallet can spare. Fall back to the fee it came with.
    const fallbackInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
      ...(currentFee > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: currentFee })] : []),
      ...budget.kept,
      ...budget.rest,
    ];
    const fallback = build(decompiled.payerKey, latest.blockhash, fallbackInstructions, tables, legacy);
    const fallbackSim = await simulate(fallback);
    if (fallbackSim.err == null) {
      finalSim = fallbackSim;
      returned = fallback;
      finalInstructions = fallbackInstructions;
      const i = changes.findIndex((c) => c.type === "priority_fee");
      if (i >= 0) changes.splice(i, 1);
      notes.push("The priority fee was left as it was: raising it to the market rate would cost more than this wallet can cover.");
    }
  }
  const finalError = await decodeSimError(finalSim.err, finalSim.logs ?? []);

  // Defence in depth: run the public verifier on our own output. If the rebuilt transaction
  // differs from the original in any way a caller would not accept, it is never returned.
  const verification = verifyInstructions(
    { payer: decompiled.payerKey, instructions: decompiled.instructions },
    { payer: decompiled.payerKey, instructions: finalInstructions },
  );
  if (!verification.ok) notes.unshift(`Internal verification refused this rebuild: ${verification.violations.join(" ")}`);
  const simulated = finalSim.err == null;
  const passed = simulated && verification.ok;

  if (!changes.some((c) => c.type === "blockhash")) {
    notes.push("A fresh blockhash is always applied, so sign and send within about 60 seconds.");
  }
  notes.push(
    "Simulation runs against current chain state. It proves the transaction executes now. It cannot guarantee inclusion if state changes before it lands.",
  );

  const wasBroken = cause != null;
  const budgetFixed = changes.some((c) => c.type === "compute_unit_limit" && /needs \d+ compute units/.test(c.reason));
  if (passed && landed && !budgetFixed && !requoted) {
    notes.unshift(
      "The original failure depended on chain state at that moment (price, liquidity or account state). That condition no longer holds, which is why the same instructions pass now. Confirm the amounts are still what you want before signing.",
    );
  }
  return {
    status: passed ? (wasBroken ? "repaired" : "valid") : "not_repairable",
    summary: !passed
      ? simulated
        ? "A rebuild was produced and it simulates, but it failed TxWhy's own safety check, so it is withheld. Nothing is returned that we cannot prove is the same transaction."
        : "The rebuilt transaction still fails simulation."
      : requoted
        ? "Repaired with a fresh quote. Only the swap instruction changed. Your tokens, amount, slippage tolerance and every other instruction are kept, and the result passes simulation."
      : wasBroken
        ? landed
          ? `On chain this failed with "${cause?.title}". Rebuilt against current state, it passes simulation.`
          : `Repaired. ${changes.length} change${changes.length === 1 ? "" : "s"} applied and the rebuilt transaction passes simulation.`
        : changes.length > 0
          ? "The transaction already executes. Returned an optimised version that is more likely to land."
          : "The transaction already executes and needs no changes.",
    cause,
    changes: passed ? changes : [],
    repairedTransaction: passed ? Buffer.from(returned.serialize()).toString("base64") : null,
    verification: passed ? verification : undefined,
    simulation: {
      passed: simulated,
      unitsConsumed: finalSim.unitsConsumed ?? null,
      error: finalError,
      logsTail: (finalSim.logs ?? []).slice(-8),
    },
    notes,
  };
}
