import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  NonceAccount,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { decodeTransactionError } from "./errors";
import { fetchIdlErrors } from "./idl";
import { lighthouseDetail } from "./lighthouse";
import { describeStandingQuote, requoteSwap } from "./requote";
import type { ProbeResult } from "./requote-pump";
import { METEORA_DBC, readDirectSwapShape, readSwapShape } from "./swap-shape";
import { RPC_URL, RpcError, rpc } from "./rpc";
import { getTrace } from "./trace";
import { V1_MAX_BYTES, decodeV1, inlineAddressCount, rebuildV1 } from "./v1";
import { type Verification, verifyInstructions } from "./verify";
import type { DecodedError, Trace } from "./types";

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

interface ParsedInner {
  instructions?: { program?: string; parsed?: { type?: string; info?: { source?: string; destination?: string; mint?: string; amount?: string; tokenAmount?: { amount?: string } } } }[];
}

/**
 * Simulate with inner instructions and keep the SPL token transfers: what the transaction would
 * actually move. Used to price a direct swap from the chain itself with its limit lifted.
 */
async function probeTransfers(base64: string): Promise<ProbeResult> {
  const { value } = await rpc<{ value: SimValue & { innerInstructions?: ParsedInner[] | null } }>("simulateTransaction", [
    base64,
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", innerInstructions: true },
  ]);
  const transfers: ProbeResult["transfers"] = [];
  for (const group of value.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) {
      const info = ix.parsed?.info;
      const type = ix.parsed?.type;
      if (!info || (type !== "transfer" && type !== "transferChecked") || !ix.program?.startsWith("spl-token")) continue;
      const amount = info.amount ?? info.tokenAmount?.amount;
      if (!info.source || !info.destination || !amount) continue;
      transfers.push({ source: info.source, destination: info.destination, amount: BigInt(amount), mint: info.mint });
    }
  }
  const errorTitle = value.err == null ? undefined : ((await decodeSimError(value.err, value.logs ?? []))?.title ?? "unknown error");
  return { err: value.err, errorTitle, transfers };
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

/** A Lighthouse guard that trips in simulation is explained from the instruction it sits in. */
function guardDetail(err: unknown, instructions: TransactionInstruction[]): DecodedError | null {
  return lighthouseDetail(err, (i) => {
    const ix = instructions[i];
    return ix ? { programId: ix.programId.toBase58(), accounts: ix.keys.map((k) => k.pubkey.toBase58()), data: ix.data } : undefined;
  });
}

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/**
 * A durable-nonce transaction starts with SystemProgram.AdvanceNonceAccount and carries the
 * nonce value where the blockhash would be. Such a transaction never expires, and it must keep
 * the nonce account's CURRENT value: a fresh blockhash would make it invalid.
 */
async function durableNonce(instructions: TransactionInstruction[]): Promise<{ account: string; current: string } | null> {
  const first = instructions[0];
  if (!first || first.programId.toBase58() !== SYSTEM_PROGRAM_ID) return null;
  const data = Buffer.from(first.data);
  if (data.length < 4 || data.readUInt32LE(0) !== 4 || first.keys.length < 1) return null;
  const account = first.keys[0].pubkey.toBase58();
  const { value } = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [account, { encoding: "base64", commitment: "confirmed" }]);
  if (!value) throw new RepairInputError(`Nonce account ${account} does not exist, so this durable-nonce transaction cannot be sent.`);
  const nonce = NonceAccount.fromAccountData(Buffer.from(value.data[0], "base64"));
  return { account, current: nonce.nonce };
}

/** Legacy and v0 transactions may not exceed this many serialized bytes; the RPC rejects larger ones outright. */
const MAX_TX_BYTES = 1232;
class TooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`The rebuilt transaction would be ${bytes} bytes, above the ${MAX_TX_BYTES}-byte limit.`);
  }
}
function assertFits(tx: VersionedTransaction): VersionedTransaction {
  const bytes = tx.serialize().length;
  if (bytes > MAX_TX_BYTES) throw new TooLargeError(bytes);
  return tx;
}

const isBlockhashNotFound = (err: unknown) => err === "BlockhashNotFound";

/**
 * Simulate a transaction whose blockhash this engine just fetched. Behind a load balancer the node
 * that answers the simulation can be a slot behind the node that issued the blockhash and reject it
 * as unknown. That is never a property of the transaction, so it is retried once and then simulated
 * with the node's own latest blockhash rather than reported as an expired transaction.
 */
async function simulateBase64(encoded: string): Promise<SimValue> {
  const run = async (replaceRecentBlockhash: boolean) =>
    (await rpc<{ value: SimValue }>("simulateTransaction", [encoded, { encoding: "base64", sigVerify: false, replaceRecentBlockhash, commitment: "confirmed" }])).value;
  let value = await run(false);
  if (isBlockhashNotFound(value.err)) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    value = await run(false);
  }
  if (isBlockhashNotFound(value.err)) value = await run(true);
  return value;
}

async function simulate(tx: VersionedTransaction): Promise<SimValue> {
  return simulateBase64(Buffer.from(assertFits(tx).serialize()).toString("base64"));
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
/** Version 1 transactions take their own path; the error carries the raw bytes so that path can start from them. */
class UnsupportedVersionError extends Error {
  constructor(public readonly base64?: string) {
    super("version 1 transaction");
  }
}

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
    return guardVersion(VersionedTransaction.deserialize(Buffer.from(result.transaction[0], "base64")), result.transaction[0]);
  } catch (e) {
    if (e instanceof UnsupportedVersionError || e instanceof RepairInputError) throw e;
    throw new UnsupportedVersionError(result.transaction[0]);
  }
}

/** web3.js 1.99 can read version 1 transactions, but nothing here can rebuild them yet. Legacy and v0 must also respect the size limit. */
function guardVersion(tx: VersionedTransaction, base64?: string): VersionedTransaction {
  if (tx.version === 1) throw new UnsupportedVersionError(base64);
  const bytes = tx.serialize().length;
  if (bytes > MAX_TX_BYTES) {
    throw new RepairInputError(`This transaction is ${bytes} bytes, above the ${MAX_TX_BYTES}-byte limit for legacy and version 0 transactions, so no node would accept it as is.`);
  }
  return tx;
}

function parseTransaction(base64: string): VersionedTransaction {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(base64.trim(), "base64"));
  } catch {
    throw new RepairInputError("Could not decode that as a base64 Solana transaction.");
  }
  return guardVersion(tx, base64.trim());
}

interface BudgetInfo {
  limit: number | null;
  price: bigint | null;
  /** Compute-budget instructions we keep untouched (heap frame, loaded-data size). */
  kept: TransactionInstruction[];
  rest: TransactionInstruction[];
}

/** Durable-nonce transactions must keep AdvanceNonceAccount as instruction 0, so budget instructions go right after it. */
function isAdvanceNonce(ix: TransactionInstruction | undefined): boolean {
  if (!ix || ix.programId.toBase58() !== SYSTEM_PROGRAM_ID) return false;
  const data = Buffer.from(ix.data);
  return data.length >= 4 && data.readUInt32LE(0) === 4;
}
function withBudget(budgetIxs: TransactionInstruction[], rest: TransactionInstruction[]): TransactionInstruction[] {
  return isAdvanceNonce(rest[0]) ? [rest[0], ...budgetIxs, ...rest.slice(1)] : [...budgetIxs, ...rest];
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

const SLIPPAGE_PATTERN = /slippage|SlippageToleranceExceeded|ExceededSlippage|TooLittleOutput|TooMuchSol|TooLittleSol|BelowMin|price impact/i;

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

/** The fix line for a final refusal depends on which refusal it is; the arbitrage text must not leak onto the others. */
function finalFix(reason: string, fallback: string): string {
  if (/circular arbitrage/i.test(reason)) return "Nothing to fix. This transaction did what it was designed to do when the opportunity was gone.";
  if (/price impact/i.test(reason)) return "Wait for liquidity or trade a smaller amount, then get a fresh quote. Do not widen slippage to force a thin route through; that is what the impact figure is warning about.";
  if (/moved more than/i.test(reason)) return "Decide whether you still want this trade at today's price. If so, get a fresh quote and rebuild; TxWhy will not move a limit that far on your behalf.";
  if (GRADUATED_PATTERN.test(reason)) return "Trade the token on the pool it migrated to (Meteora DAMM v2 for DBC launches), directly or through Jupiter. Resending or re-quoting against the launch pool cannot succeed.";
  return fallback;
}

export interface RepairInput {
  signature?: string;
  transaction?: string;
}

const formatUnits = (raw: bigint, decimals: number) => {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${whole}${frac ? "." + frac : ""}`;
};

/**
 * The token program's "insufficient funds" inside a swap, with numbers: what the swap spends and
 * what the source token account actually holds right now. The usual story is a sell built from a
 * stale balance (part of it already sold), so the exact figure is what the person needs.
 */
async function tokenShortfall(instructions: TransactionInstruction[], logs: string[]): Promise<{ cause: DecodedError; note: string } | null> {
  if (!logs.some((l) => /Program log: Error: insufficient funds/i.test(l))) return null;
  for (const ix of instructions) {
    let account: string | undefined;
    let amount: bigint | undefined;
    let what = "";
    const direct = readDirectSwapShape(ix);
    if (direct && direct.userIn != null && (direct.fixed === "tokens_in" || direct.fixed === "quote_in")) {
      account = ix.keys[direct.userIn]?.pubkey.toBase58();
      amount = direct.amount;
      what = `${direct.program} ${direct.name}`;
    } else {
      const jup = readSwapShape(ix);
      if (jup && jup.mode === "ExactIn") {
        account = jup.source;
        amount = jup.amount;
        what = "Jupiter swap";
      }
    }
    if (!account || amount == null) continue;
    const balance = await rpc<{ value: { amount: string; decimals: number } | null }>("getTokenAccountBalance", [account, { commitment: "confirmed" }]).catch(() => null);
    if (!balance?.value) continue;
    const have = BigInt(balance.value.amount);
    if (have >= amount) continue;
    const fmt = (v: bigint) => formatUnits(v, balance.value!.decimals);
    return {
      cause: {
        title: "Not enough tokens to swap",
        code: "Custom(1) — 0x1",
        cause: `The ${what} spends ${fmt(amount)} from token account ${account}, which holds ${fmt(have)}. Usually the amount came from a balance that was already partly sold or transferred.`,
        fix: `Rebuild the swap for at most ${fmt(have)}, or top the account up by ${fmt(amount - have)} first. TxWhy never changes the amount you chose, so there is no repair to return.`,
      },
      note: `Source token account ${account}: holds ${fmt(have)}, the swap needs ${fmt(amount)}. Shortfall: ${fmt(amount - have)}.`,
    };
  }
  return null;
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DBC_POOL_PATTERN = /InsufficientLiquidity|SwapAmountIsOverAThreshold|NotEnoughLiquidity|PoolIsCompleted/;

/**
 * Meteora DBC refusals that have numbers behind them. InsufficientLiquidity (6033, named
 * SwapAmountIsOverAThreshold in older IDLs) is a buy larger than what is left on the bonding curve
 * before the pool graduates; PoolIsCompleted (6013) is a pool that already graduated. Both are
 * answered from the pool's own account: how much room is left, and the DAMM v2 pool the token moves to.
 */
export async function dbcPoolVerdict(instructions: TransactionInstruction[], cause: DecodedError, logs: string[]): Promise<{ cause: DecodedError; note: string } | null> {
  if (!DBC_POOL_PATTERN.test(cause.title) || innermostFailedProgram(logs) !== METEORA_DBC) return null;
  const hit = instructions.map((ix) => ({ ix, shape: readDirectSwapShape(ix) })).find((h) => h.shape?.program === "Meteora DBC");
  const poolAddress = hit?.ix.keys[2]?.pubkey.toBase58();
  if (!hit?.shape || !poolAddress) return null;
  const sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const client = new sdk.DynamicBondingCurveClient(new Connection(RPC_URL, "confirmed"), "confirmed");
  const pool = (await client.state.getPool(poolAddress))?.poolState;
  if (!pool) return null;
  const config = await client.state.getPoolConfig(pool.config);
  if (!config) return null;
  const quoteMint = config.quoteMint.toBase58();
  const decimals =
    quoteMint === SOL_MINT ? 9 : quoteMint === USDC_MINT ? 6 : ((await rpc<{ value: { decimals: number } }>("getTokenSupply", [quoteMint]).catch(() => null))?.value.decimals ?? 0);
  const unit = quoteMint === SOL_MINT ? "SOL" : quoteMint === USDC_MINT ? "USDC" : `of quote token ${quoteMint}`;
  const fmt = (v: bigint) => `${formatUnits(v, decimals)} ${unit}`;
  const threshold = BigInt(config.migrationQuoteThreshold.toString());
  const raised = BigInt(pool.quoteReserve.toString());
  const feeConfig = sdk.DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  const dammV2 = config.migrationOption === 1 && feeConfig ? sdk.deriveDammV2PoolAddress(feeConfig, pool.baseMint, config.quoteMint).toBase58() : null;
  const where = dammV2 ? `Meteora DAMM v2 pool ${dammV2}` : config.migrationOption === 0 ? "a Meteora DAMM v1 pool" : "a Meteora DAMM v2 pool";
  if (pool.isMigrated !== 0 || raised >= threshold) {
    const moved = pool.isMigrated !== 0 ? "its liquidity moved to" : "its liquidity is being moved to";
    return {
      cause: {
        title: "Launch pool already graduated",
        code: cause.code,
        cause: `Meteora DBC pool ${poolAddress} completed its bonding curve (${fmt(raised)} raised; ${fmt(threshold)} graduates it) and ${moved} ${where}. No swap against the launch pool can succeed any more.`,
        fix: `Trade the token on ${where} instead, directly or through Jupiter, which routes there. Resending this transaction cannot succeed.`,
      },
      note: `Meteora DBC pool ${poolAddress} graduated: ${fmt(raised)} raised of ${fmt(threshold)}. Its liquidity sits in ${where}.`,
    };
  }
  const room = threshold - raised;
  const exactIn = hit.shape.fixed === "tokens_in";
  return {
    cause: {
      title: "Launch pool nearly full",
      code: cause.code,
      cause: `Meteora DBC pool ${poolAddress} has ${fmt(room)} of room left before it graduates (${fmt(raised)} raised; ${fmt(threshold)} graduates it). ${exactIn ? `This buy puts in ${fmt(hit.shape.amount)}, more than the curve can take` : "This buy asks for more tokens than the curve has left to sell"}, and the program refuses the whole swap rather than fill part of it.`,
      fix: `Buy at most ${fmt(room)} now, or send swap2 in partial-fill mode (swap mode 1), which buys what is left and returns the rest. Once the pool graduates the token trades on ${where}. TxWhy never changes the amount you chose, so there is no repair to return.`,
    },
    note: `Meteora DBC pool ${poolAddress}: ${fmt(raised)} raised, ${fmt(threshold)} graduates it, ${fmt(room)} left.${exactIn ? ` This buy: ${fmt(hit.shape.amount)}.` : ""}`,
  };
}

/**
 * The refusals that can be stated with exact figures from live state instead of the program's one-line
 * error. `replaces` says which on-chain causes the precise one may stand in for: a pool that graduated
 * since must not overwrite an on-chain "insufficient funds", and vice versa.
 */
async function preciseVerdict(instructions: TransactionInstruction[], cause: DecodedError, logs: string[]): Promise<{ cause: DecodedError; note: string; replaces: RegExp } | null> {
  if (cause.title === "InsufficientFunds") {
    const precise = await tokenShortfall(instructions, logs);
    return precise ? { ...precise, replaces: /^InsufficientFunds$/ } : null;
  }
  const precise = await dbcPoolVerdict(instructions, cause, logs).catch(() => null);
  return precise ? { ...precise, replaces: DBC_POOL_PATTERN } : null;
}

/**
 * The runtime's post-execution rent check names an account only by its index. Say which account it is,
 * what it holds, and the rent-exempt minimum for its size, so the fix is a number rather than a rule.
 */
async function rentShortfall(err: unknown, keys: PublicKey[]): Promise<{ cause: DecodedError; note: string } | null> {
  const detail = err && typeof err === "object" ? (err as { InsufficientFundsForRent?: { account_index?: number } }).InsufficientFundsForRent : undefined;
  const index = detail?.account_index;
  if (index == null || !keys[index]) return null;
  const address = keys[index].toBase58();
  const info = (await rpc<{ value: { lamports: number; space?: number } | null }>("getAccountInfo", [address, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }]).catch(() => null))?.value ?? null;
  const space = info?.space ?? 0;
  const minimum = await rpc<number>("getMinimumBalanceForRentExemption", [space]).catch(() => null);
  if (minimum == null) return null;
  const holds = info?.lamports ?? 0;
  const sol = (v: number) => `${(v / 1e9).toFixed(6)} SOL`;
  const exists = info != null;
  return {
    cause: {
      title: "Account left below rent minimum",
      code: "InsufficientFundsForRent",
      cause: `After this transaction, account ${address} (#${index + 1} in the account list) would hold less than the rent-exempt minimum, and the runtime refuses any transaction that leaves an account under that line. ${
        exists
          ? `It holds ${sol(holds)} now and stores ${space} bytes, so its minimum is ${sol(minimum)}.`
          : `It does not exist yet, so whatever creates it must fund it with at least ${sol(minimum)}, the minimum for an empty account; more for any data it stores.`
      }`,
      fix: exists
        ? `Leave at least ${sol(minimum)} in ${address} after the transaction: lower the amount it sends, or top the account up first.${holds < minimum ? ` It is already ${sol(minimum - holds)} short.` : ""}`
        : `Fund ${address} with at least ${sol(minimum)} in the same transaction (a System transfer or a create with enough lamports), then resend.`,
    },
    note: `Rent check: ${address} holds ${sol(holds)}; the minimum for ${space} bytes is ${sol(minimum)}.`,
  };
}

const RENT_PATTERN = /^Insufficient funds for rent$|^Account left below rent minimum$/;

const GRADUATED_PATTERN = /completed its bonding curve/;
/** With the limit lifted the swap fails on money, not price: a fresh quote cannot help, so the verdict is final. */
const FUNDS_NOW_PATTERN = /still fails \((Insufficient SOL|InsufficientFunds|Not enough tokens to swap)\)/;

/**
 * The node can refuse a transaction before running a single instruction ("invalid transaction: ..."):
 * duplicate ComputeBudget instructions, malformed instruction data, a fee payer that is a program,
 * too many account locks. That is a diagnosis of the caller's transaction, not an upstream fault, so
 * it is answered as not_repairable with the exact reason instead of a retryable 502.
 */
const SANITIZE_PATTERN = /^invalid transaction: (.+)$/i;

function sanitizeCause(reason: string): DecodedError {
  const r = reason.replace(/\s+$/, "");
  if (/duplicate instruction/i.test(r)) {
    return {
      title: "Duplicate compute-budget instruction",
      code: "sanitize",
      cause: `The node rejected the transaction before running it: ${r}. A transaction may carry at most one ComputeBudget instruction of each kind.`,
      fix: "Keep one SetComputeUnitLimit, one SetComputeUnitPrice and at most one SetLoadedAccountsDataSizeLimit, then resend.",
    };
  }
  if (/invalid instruction data/i.test(r)) {
    return {
      title: "Malformed instruction data",
      code: "sanitize",
      cause: `The node rejected the transaction before running it: ${r}. The instruction's data does not match what its program expects (wrong tag, missing fields, or truncated).`,
      fix: "Rebuild the instruction with the program's SDK or IDL so its data layout is exactly what the program defines.",
    };
  }
  if (/sanitize accounts offsets|fee payer|account index|invalid account reference|out of bounds|program.*cannot be/i.test(r)) {
    return {
      title: "Invalid account layout",
      code: "sanitize",
      cause: `The node rejected the transaction before running it: ${r}. The fee payer must be a signing wallet (never a program or the system program), and every instruction's account indexes must point inside the account list.`,
      fix: "Set a real wallet as the fee payer and rebuild the account list with your SDK, then resend.",
    };
  }
  if (/too many account locks|locks too many/i.test(r)) {
    return {
      title: "Too many accounts",
      code: "sanitize",
      cause: `The node rejected the transaction before running it: ${r}. A transaction may lock at most 64 accounts.`,
      fix: "Split the transaction, or use an address lookup table so fewer accounts are listed inline.",
    };
  }
  return {
    title: "Rejected before execution",
    code: "sanitize",
    cause: `The node rejected the transaction before running it: ${r}.`,
    fix: "Fix the transaction structure named above and resend; no repair can change it for you.",
  };
}

export async function repair(input: RepairInput): Promise<RepairResult> {
  try {
    const result = await repairUnguarded(input);
    // A tripped wallet guard is never "needs a fresh quote": the app has to build a new transaction with new guards.
    if (result.status !== "repaired" && result.status !== "valid" && result.cause?.title.startsWith("Lighthouse guard")) {
      return { ...result, status: "not_repairable", summary: "A safety guard set by the wallet or app that built this transaction aborted it. Nothing was swapped. Only that app can build a fresh transaction with new guards.", repairedTransaction: null };
    }
    return result;
  } catch (e) {
    const reason = e instanceof RpcError ? e.message.match(SANITIZE_PATTERN)?.[1] : undefined;
    if (!reason) throw e;
    const cause = sanitizeCause(reason);
    return {
      status: "not_repairable",
      summary: `${cause.title}: the node refuses this transaction before executing it. ${cause.fix}`,
      cause,
      changes: [],
      repairedTransaction: null,
      simulation: { passed: false, unitsConsumed: null, error: cause, logsTail: [] },
      notes: [],
    };
  }
}

async function repairUnguarded(input: RepairInput): Promise<RepairResult> {
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
    if (e.base64) {
      try {
        return await repairV1(e.base64, onchain);
      } catch (inner) {
        if (inner instanceof RepairInputError || inner instanceof RpcError) throw inner;
        /* fall through to diagnosis-only below */
      }
    }
    // Nodes simulate version 1 bytes as they are, so a v1 transaction still gets an exact diagnosis.
    let v1Sim: SimValue | null = null;
    if (input.transaction && !onchain) {
      try {
        v1Sim = (await rpc<{ value: SimValue }>("simulateTransaction", [input.transaction.trim(), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])).value;
      } catch {
        /* diagnosis stays generic */
      }
    }
    const cause = onchain?.error ?? (v1Sim ? await decodeSimError(v1Sim.err, v1Sim.logs ?? []) : null);
    const passes = v1Sim != null && v1Sim.err == null;
    return {
      status: passes ? "valid" : "not_repairable",
      summary: passes
        ? "This version 1 transaction passes simulation as it is."
        : "Diagnosed, but not rebuilt: this is a version 1 transaction (SIMD-0385, live on mainnet since Sep 15, 2026). Its compute settings live in the header rather than in instructions, and the rebuild path for that format is in progress.",
      cause,
      changes: [],
      repairedTransaction: null,
      simulation: {
        passed: passes,
        unitsConsumed: v1Sim?.unitsConsumed ?? null,
        error: cause,
        logsTail: (onchain?.logs ?? v1Sim?.logs ?? []).slice(-8),
      },
      notes: passes ? [] : ["Apply the fix above when you rebuild the transaction in your own client."],
    };
  }
  const landed = onchain != null;

  let legacy = original.version === "legacy";
  let tables = await loadLookupTables(original);
  let decompiled: TransactionMessage;
  try {
    decompiled = TransactionMessage.decompile(original.message, { addressLookupTableAccounts: tables });
  } catch (e) {
    // web3 checks the header and account indexes here, not at deserialize time: bad input, not a server fault.
    throw new RepairInputError(`This transaction's message is malformed (${e instanceof Error ? e.message : String(e)}); no node would accept it.`);
  }
  const budget = splitComputeBudget(decompiled.instructions);
  const notes: string[] = [];
  const messageKeys = original.message.getAccountKeys({ addressLookupTableAccounts: tables });
  const accountKeys = Array.from({ length: messageKeys.length }, (_, i) => messageKeys.get(i)).filter((k): k is PublicKey => k != null);
  if (onchain?.rawError != null) {
    const rent = await rentShortfall(onchain.rawError, accountKeys).catch(() => null);
    if (rent) {
      onchain.error = rent.cause;
      notes.push(rent.note);
    }
  }
  const changes: RepairChange[] = [];

  // 1. Was the submitted blockhash still usable?
  const originalBlockhash = decompiled.recentBlockhash;
  const [{ value: blockhashValid }, { value: fresh }, nonce] = await Promise.all([
    rpc<{ value: boolean }>("isBlockhashValid", [originalBlockhash, { commitment: "confirmed" }]),
    rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
    durableNonce(decompiled.instructions),
  ]);
  // For a durable-nonce transaction the "blockhash" slot must hold the nonce account's current value.
  const latest = nonce ? { blockhash: nonce.current } : fresh;
  if (nonce) {
    if (nonce.current !== originalBlockhash) {
      notes.push(`Durable-nonce transaction: nonce account ${nonce.account} has advanced since this was built, so the current value is used in place of the original.`);
      changes.push({
        type: "blockhash",
        before: originalBlockhash,
        after: nonce.current,
        reason: `Durable nonce: the nonce account ${nonce.account} has advanced since this transaction was built, so the transaction carries its current value.`,
      });
    } else {
      notes.push(`Durable-nonce transaction (nonce account ${nonce.account}). It does not expire, and the nonce value was kept.`);
    }
  }

  // 2. Simulate the transaction AS SUBMITTED (only the blockhash refreshed, otherwise
  //    an expired blockhash would mask every other problem).
  const asSubmitted = build(decompiled.payerKey, latest.blockhash, decompiled.instructions, tables, legacy);
  // The as-submitted run and the maximum-budget probe (step 3) are independent, so they run together.
  const probe = build(
    decompiled.payerKey,
    latest.blockhash,
    withBudget([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept], budget.rest),
    tables,
    legacy,
  );
  const [submittedSim, probeResult] = await Promise.all([
    simulate(asSubmitted),
    simulate(probe).catch((e) => {
      if (e instanceof TooLargeError) return null; // no room for a measuring instruction; fall back to the as-submitted run
      throw e;
    }),
  ]);
  const firstProbeSim = probeResult ?? submittedSim;
  if (!probeResult) notes.push("This transaction is at the 1,232-byte size limit, so no compute-budget instruction could be added to measure its real usage. Its own settings were kept.");
  let cause = onchain?.error ?? guardDetail(submittedSim.err, decompiled.instructions) ?? (await decodeSimError(submittedSim.err, submittedSim.logs ?? []));
  if (landed) {
    changes.push({
      type: "blockhash",
      before: originalBlockhash,
      after: latest.blockhash,
      reason: "The original transaction already landed and failed. Resending it requires a new blockhash.",
    });
  } else if (!blockhashValid && !nonce) {
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
        withBudget([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept], budget.rest),
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
    const titleChanged = landed && onchain?.error != null && probeCause != null && onchain.error.title !== probeCause.title;
    const rent = verdict.status === "not_repairable" ? await rentShortfall(probeSim.err, accountKeys).catch(() => null) : null;
    const precise = rent ? { ...rent, replaces: RENT_PATTERN } : verdict.status === "not_repairable" && probeCause ? await preciseVerdict(budget.rest, probeCause, probeSim.logs ?? []) : null;
    if (precise) {
      verdict.cause = precise.cause;
      verdict.notes.push(precise.note);
      if (onchain?.error && precise.replaces.test(onchain.error.title)) onchain.error = precise.cause;
    }
    if (titleChanged && !precise && onchain?.error && probeCause) {
      notes.push(
        `Re-run today, this transaction fails earlier than it did on chain ("${probeCause.title}") because the accounts and prices it referenced have since changed. That is normal for a transaction that already landed; the on-chain cause above is the one that counts.`,
      );
    }
    // Slippage: the amounts are inside the instruction, so rebuild the swap from a fresh quote.
    // A landed swap that failed on slippage needs a fresh quote whatever its stale route does today.
    const failedOnSlippage = onchain?.error != null && SLIPPAGE_PATTERN.test(`${onchain.error.title} ${onchain.error.code ?? ""}`);
    const wantsRequote = verdict.status === "needs_requote" || failedOnSlippage;
    let notSlippage = false;
    if (wantsRequote) {
      const runRequote = () =>
        requoteSwap(budget.rest, {
          logs: submittedSim.logs ?? [],
          probe: (lifted) =>
            probeTransfers(
              Buffer.from(
                assertFits(build(decompiled.payerKey, latest.blockhash, withBudget([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept], lifted), tables, legacy)).serialize(),
              ).toString("base64"),
            ),
        });
      /** Put a re-quoted swap into the transaction and simulate it at the maximum budget. */
      const trySplice = async (quoted: { instructions: TransactionInstruction[]; lookupTables: string[] }) => {
        const extra = await loadTablesByAddress(quoted.lookupTables.filter((a) => !tables.some((t) => t.key.toBase58() === a)));
        const mergedTables = [...tables, ...extra];
        const needsV0 = legacy && mergedTables.length > 0;
        const candidate = () =>
          build(
            decompiled.payerKey,
            latest.blockhash,
            withBudget([ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_CU }), ...budget.kept], quoted.instructions),
            mergedTables,
            legacy && !needsV0,
          );
        let sim = await simulate(candidate());
        if (hitLoadedDataLimit(sim.err) && liftLoadedDataLimit("The fresh route loads different accounts than the limit the original transaction declared.")) {
          sim = await simulate(candidate());
        }
        return { sim, mergedTables, needsV0 };
      };
      let requote = await runRequote();
      if (requote.ok) {
        try {
          let spliced = await trySplice(requote);
          // A Jupiter quote can go stale in the moment between quoting and simulating on a fast token.
          // One more quote is cheap; a second miss is reported as it is.
          if (spliced.sim.err != null && !requote.program && SLIPPAGE_PATTERN.test((spliced.sim.logs ?? []).join(" "))) {
            const second = await runRequote();
            if (second.ok) {
              requote = second;
              spliced = await trySplice(second);
            }
          }
          const { sim: reprobeSim, mergedTables, needsV0 } = spliced;
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
              reason: requote.program
                ? `The price moved past the limit in the original ${requote.program} swap, so only that limit was moved to the current price.`
                : "The price moved past the tolerance in the original swap, so that one instruction was rebuilt from a current quote.",
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
        if (requote.fits || FUNDS_NOW_PATTERN.test(requote.reason)) notSlippage = true;
      }
    }

    if (!requoted && finalVerdict) {
      const base = landed ? (onchain?.error ?? verdict.cause ?? probeCause) : (verdict.cause ?? probeCause);
      const graduated = GRADUATED_PATTERN.test(finalVerdict) ? await dbcPoolVerdict(budget.rest, { title: "PoolIsCompleted", code: base?.code, cause: "", fix: "" }, probeSim.logs ?? []).catch(() => null) : null;
      return {
        status: "not_repairable",
        summary: finalVerdict,
        cause: graduated ? graduated.cause : base ? { ...base, fix: finalFix(finalVerdict, base.fix) } : null,
        changes: [],
        repairedTransaction: null,
        simulation: {
          passed: false,
          unitsConsumed: probeSim.unitsConsumed ?? null,
          error: probeCause,
          logsTail: (probeSim.logs ?? []).slice(-12),
        },
        notes: graduated ? [graduated.note] : [],
      };
    }
    if (!requoted) return {
      status: wantsRequote && !notSlippage ? "needs_requote" : verdict.status === "needs_requote" ? "not_repairable" : verdict.status,
      summary:
        wantsRequote && !notSlippage
          ? "With a fresh blockhash this transaction still fails on slippage, so it needs a fresh quote."
          : (verdict.cause?.cause ?? (landed ? onchain?.error?.cause : undefined) ?? "This transaction fails for a reason that cannot be fixed by rebuilding it."),
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
        "Raised to the 75th percentile of priority fees paid in the last minutes on the accounts this transaction writes to, so it is not dropped or delayed under load. The total is capped at 0.001 SOL; a fee you set yourself is never lowered.",
    });
  }

  // 6. Build the final transaction and prove it.
  let finalInstructions = withBudget(
    [ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }), ...budget.kept],
    budget.rest,
  );
  let finalTx = build(decompiled.payerKey, latest.blockhash, finalInstructions, tables, legacy);
  const fits = (tx: VersionedTransaction) => tx.serialize().length <= MAX_TX_BYTES;
  if (!fits(finalTx)) {
    // A transaction built right up to the size limit has no room for a fee instruction. Keep its fee.
    const i = changes.findIndex((c) => c.type === "priority_fee");
    if (i >= 0) changes.splice(i, 1);
    notes.push("There is no room left in this transaction for a priority-fee instruction (1,232-byte limit), so its fee was left as it was.");
    finalInstructions = withBudget([ComputeBudgetProgram.setComputeUnitLimit({ units: limit }), ...budget.kept], budget.rest);
    finalTx = build(decompiled.payerKey, latest.blockhash, finalInstructions, tables, legacy);
  }
  if (!fits(finalTx)) {
    const k = changes.findIndex((c) => c.type === "compute_unit_limit");
    if (k >= 0) changes.splice(k, 1);
    notes.push("Nor for a compute-limit instruction, so the original compute settings were kept.");
    finalInstructions = withBudget(
      [...(budget.limit != null ? [ComputeBudgetProgram.setComputeUnitLimit({ units: budget.limit })] : []), ...budget.kept],
      budget.rest,
    );
    finalTx = build(decompiled.payerKey, latest.blockhash, finalInstructions, tables, legacy);
  }
  let finalSim = await simulate(finalTx);
  let returned = finalTx;
  if (finalSim.err != null && fee !== currentFee) {
    // The raised fee may be more than the wallet can spare. Fall back to the fee it came with.
    const fallbackInstructions = withBudget(
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
        ...(currentFee > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: currentFee })] : []),
        ...budget.kept,
      ],
      budget.rest,
    );
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
  if (passed && landed && !requoted && cause && SLIPPAGE_PATTERN.test(`${cause.title} ${cause.code ?? ""}`)) {
    const standing = await describeStandingQuote(budget.rest);
    if (standing) notes.unshift(standing);
  }
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

/**
 * Version 1 transactions. Same decisions as the legacy path, but the compute settings live in
 * the header config (priority fee in total lamports), there are no lookup tables, and the size
 * limit is 4,096 bytes. Bytes are produced by @solana/kit; everything else reuses the engine.
 */
async function repairV1(base64: string, onchain: Trace | null): Promise<RepairResult> {
  const decoded = decodeV1(base64);
  const landed = onchain != null;
  const notes: string[] = [];
  const changes: RepairChange[] = [];
  const v1Note = "Version 1 transaction (SIMD-0385): compute settings are carried in the header, so the repair edits the header instead of adding instructions.";

  // 1. Lifetime: a fresh blockhash, or for a durable nonce the account's current value.
  let lifetime: { blockhash?: string; nonce?: { value: string; account: string; authority: string } } = {};
  let expiredCause: DecodedError | null = null;
  if ("nonce" in decoded.lifetime) {
    const first = decoded.instructions[0];
    if (!isAdvanceNonce(first)) throw new RepairInputError("This version 1 transaction declares a nonce lifetime but does not start with AdvanceNonceAccount.");
    const account = first.keys[0].pubkey.toBase58();
    const authority = first.keys[2]?.pubkey.toBase58() ?? decoded.payerKey.toBase58();
    const { value } = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [account, { encoding: "base64", commitment: "confirmed" }]);
    if (!value) throw new RepairInputError(`Nonce account ${account} does not exist, so this durable-nonce transaction cannot be sent.`);
    const current = NonceAccount.fromAccountData(Buffer.from(value.data[0], "base64")).nonce;
    lifetime = { nonce: { value: current, account, authority } };
    if (current !== decoded.lifetime.nonce) {
      changes.push({ type: "blockhash", before: decoded.lifetime.nonce, after: current, reason: `Durable nonce: the nonce account ${account} has advanced since this transaction was built, so the transaction carries its current value.` });
    } else {
      notes.push(`Durable-nonce transaction (nonce account ${account}). It does not expire, and the nonce value was kept.`);
    }
  } else {
    const [{ value: valid }, { value: fresh }] = await Promise.all([
      rpc<{ value: boolean }>("isBlockhashValid", [decoded.lifetime.blockhash, { commitment: "confirmed" }]),
      rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
    ]);
    lifetime = { blockhash: fresh.blockhash };
    if (landed) {
      changes.push({ type: "blockhash", before: decoded.lifetime.blockhash, after: fresh.blockhash, reason: "The original transaction already landed and failed. Resending it requires a new blockhash." });
    } else if (!valid) {
      expiredCause = {
        title: "Blockhash expired",
        code: "BlockhashNotFound",
        cause: "The recent blockhash in this transaction is no longer valid. Too much time passed between building and landing it (a blockhash lives roughly 60 to 90 seconds).",
        fix: "Rebuild with a fresh blockhash immediately before signing and sending.",
      };
      changes.push({ type: "blockhash", before: decoded.lifetime.blockhash, after: fresh.blockhash, reason: "The original blockhash had expired." });
    }
  }

  const simulateV1 = async (b64: string, bytes: number): Promise<SimValue> => {
    if (bytes > V1_MAX_BYTES) throw new TooLargeError(bytes);
    return simulateBase64(b64);
  };
  const build = (opts: Parameters<typeof rebuildV1>[1]) => rebuildV1(decoded, { ...lifetime, ...opts });

  // 2. As submitted (lifetime refreshed only), and the maximum-budget probe, together.
  const original = decoded.config;
  const MAX_DATA = 64 * 1024 * 1024;
  const probeConfig = { ...original, computeUnitLimit: MAX_CU, loadedAccountsDataSizeLimit: MAX_DATA };
  const asSubmitted = build({});
  const probe = build({ config: probeConfig });
  const [submittedSim, probeSim0] = await Promise.all([simulateV1(asSubmitted.base64, asSubmitted.bytes), simulateV1(probe.base64, probe.bytes)]);
  let cause = onchain?.error ?? guardDetail(submittedSim.err, decoded.instructions) ?? (await decodeSimError(submittedSim.err, submittedSim.logs ?? [])) ?? expiredCause;
  let probeSim = probeSim0;
  let instructions = decoded.instructions;
  let requoted = false;
  // Unset means zero bytes in v1: every such transaction fails until the limit is set.
  const liftedData = original.loadedAccountsDataSizeLimit == null || hitLoadedDataLimit(submittedSim.err);

  // 3. Anything other than budget wrong? (Mirrors the legacy verdict logic.)
  let finalVerdict: string | null = null;
  if (probeSim.err != null) {
    const probeCause = (await decodeSimError(probeSim.err, probeSim.logs ?? [])) ?? cause;
    const verdict = classifyUnrepairable(probeCause ?? { title: "Unknown failure", cause: "", fix: "" }, probeSim.logs ?? []);
    const titleChanged = landed && onchain?.error != null && probeCause != null && onchain.error.title !== probeCause.title;
    const precise = verdict.status === "not_repairable" && probeCause ? await preciseVerdict(decoded.instructions, probeCause, probeSim.logs ?? []) : null;
    if (precise) {
      verdict.cause = precise.cause;
      verdict.notes.push(precise.note);
      if (onchain?.error && precise.replaces.test(onchain.error.title)) onchain.error = precise.cause;
    }
    if (titleChanged && !precise && onchain?.error && probeCause) {
      notes.push(`Re-run today, this transaction fails earlier than it did on chain ("${probeCause.title}") because the accounts and prices it referenced have since changed. That is normal for a transaction that already landed; the on-chain cause above is the one that counts.`);
    }
    const failedOnSlippage = onchain?.error != null && SLIPPAGE_PATTERN.test(`${onchain.error.title} ${onchain.error.code ?? ""}`);
    const wantsRequote = verdict.status === "needs_requote" || failedOnSlippage;
    let notSlippage = false;
    if (wantsRequote) {
      const requote = await requoteSwap(decoded.instructions, {
        logs: submittedSim.logs ?? [],
        probe: (lifted) => {
          const candidate = build({ config: probeConfig, instructions: lifted });
          if (candidate.bytes > V1_MAX_BYTES) throw new TooLargeError(candidate.bytes);
          return probeTransfers(candidate.base64);
        },
      });
      if (requote.ok) {
        const inline = inlineAddressCount(decoded.payerKey, requote.instructions);
        if (inline > 64) {
          notes.push(`The fresh route needs ${inline} distinct accounts, more than the 64 a version 1 transaction can carry inline, so it was not applied.`);
        } else {
          try {
            const reprobe = build({ config: probeConfig, instructions: requote.instructions });
            const reprobeSim = await simulateV1(reprobe.base64, reprobe.bytes);
            if (reprobeSim.err == null) {
              instructions = requote.instructions;
              probeSim = reprobeSim;
              requoted = true;
              cause = cause ?? verdict.cause ?? probeCause;
              changes.push({ type: "swap_quote", before: requote.before, after: requote.after, reason: requote.program ? `The price moved past the limit in the original ${requote.program} swap, so only that limit was moved to the current price.` : "The price moved past the tolerance in the original swap, so that one instruction was rebuilt from a current quote." });
              notes.push(...requote.notes, "Quotes go stale within seconds. Sign and send immediately.");
            } else {
              const again = await decodeSimError(reprobeSim.err, reprobeSim.logs ?? []);
              notes.push(`A fresh quote was spliced in but the transaction still fails simulation (${again?.title ?? "unknown error"}), so it is not returned.`);
            }
          } catch (e) {
            notes.push(e instanceof Error ? e.message : "The re-quoted transaction could not be assembled.");
          }
        }
      } else if (requote.final) {
        finalVerdict = requote.reason;
      } else {
        notes.push(requote.reason);
        if (requote.fits || FUNDS_NOW_PATTERN.test(requote.reason)) notSlippage = true;
      }
    }
    if (!requoted) {
      const base = landed ? (onchain?.error ?? verdict.cause ?? probeCause) : (verdict.cause ?? probeCause);
      const slippageNow = wantsRequote && !notSlippage;
      const graduated = finalVerdict && GRADUATED_PATTERN.test(finalVerdict) ? await dbcPoolVerdict(decoded.instructions, { title: "PoolIsCompleted", code: base?.code, cause: "", fix: "" }, probeSim.logs ?? []).catch(() => null) : null;
      return {
        status: finalVerdict ? "not_repairable" : slippageNow ? "needs_requote" : verdict.status === "needs_requote" ? "not_repairable" : verdict.status,
        summary: finalVerdict ?? (slippageNow ? "With a fresh blockhash this transaction still fails on slippage, so it needs a fresh quote." : (verdict.cause?.cause ?? "This transaction fails for a reason that cannot be fixed by rebuilding it.")),
        cause: graduated ? graduated.cause : finalVerdict && base ? { ...base, fix: finalFix(finalVerdict, base.fix) } : base,
        changes: [],
        repairedTransaction: null,
        simulation: { passed: false, unitsConsumed: probeSim.unitsConsumed ?? null, error: probeCause, logsTail: (probeSim.logs ?? []).slice(-12) },
        notes: finalVerdict ? (graduated ? [graduated.note] : []) : [...verdict.notes, ...notes],
      };
    }
  }

  // 4. Compute unit limit from the measurement.
  const measured = probeSim.unitsConsumed ?? 0;
  const newLimit = Math.min(MAX_CU, Math.ceil(measured * CU_HEADROOM));
  const oldLimit = original.computeUnitLimit;
  if (oldLimit == null || oldLimit < measured || oldLimit > newLimit * 3) {
    changes.push({
      type: "compute_unit_limit",
      before: oldLimit == null ? "not set (zero: a version 1 transaction with no limit cannot run)" : String(oldLimit),
      after: String(newLimit),
      reason: oldLimit != null && oldLimit < measured ? `The transaction needs ${measured} compute units but its limit was ${oldLimit}.` : `Sized to measured usage (${measured} units) plus 15% headroom.`,
    });
  }
  const limit = changes.some((c) => c.type === "compute_unit_limit") ? newLimit : (oldLimit as number);
  if (liftedData) {
    changes.push({
      type: "loaded_accounts_data_limit",
      before: original.loadedAccountsDataSizeLimit == null ? "not set (zero bytes in version 1)" : `${original.loadedAccountsDataSizeLimit.toLocaleString("en-US")} bytes`,
      after: "64 MB",
      reason: original.loadedAccountsDataSizeLimit == null ? "A version 1 transaction with no loaded-data limit is budgeted zero bytes and cannot run." : "The transaction loads more account data than the limit it declared for itself.",
    });
  }

  // 5. Priority fee, in total lamports for v1.
  const writableSet = new Map<string, PublicKey>([[decoded.payerKey.toBase58(), decoded.payerKey]]);
  for (const ix of instructions) for (const k of ix.keys) if (k.isWritable) writableSet.set(k.pubkey.toBase58(), k.pubkey);
  const rate = await recentPriorityFee([...writableSet.values()]); // micro-lamports per CU
  const marketLamports = Math.min(MAX_PRIORITY_LAMPORTS, Math.ceil((rate * limit) / 1_000_000));
  const currentLamports = Number(original.priorityFeeLamports ?? BigInt(0));
  let feeLamports = currentLamports;
  if (currentLamports < marketLamports) {
    feeLamports = marketLamports;
    changes.push({
      type: "priority_fee",
      before: currentLamports === 0 ? "none" : `${currentLamports} lamports`,
      after: `${marketLamports} lamports (${rate} micro-lamports per CU x ${limit} units)`,
      reason: "Raised to the 75th percentile of priority fees paid in the last minutes on the accounts this transaction writes to, so it is not dropped or delayed under load. The total is capped at 0.001 SOL; a fee you set yourself is never lowered.",
    });
  }

  // 6. Final build and proof.
  const finalConfig = { ...original, computeUnitLimit: limit, priorityFeeLamports: BigInt(feeLamports), ...(liftedData ? { loadedAccountsDataSizeLimit: MAX_DATA } : {}) };
  let final = build({ config: finalConfig, instructions });
  let finalSim = await simulateV1(final.base64, final.bytes);
  if (finalSim.err != null && feeLamports !== currentLamports) {
    const fallback = build({ config: { ...finalConfig, priorityFeeLamports: BigInt(currentLamports) }, instructions });
    const fallbackSim = await simulateV1(fallback.base64, fallback.bytes);
    if (fallbackSim.err == null) {
      final = fallback;
      finalSim = fallbackSim;
      const i = changes.findIndex((c) => c.type === "priority_fee");
      if (i >= 0) changes.splice(i, 1);
      notes.push("The priority fee was left as it was: raising it to the market rate would cost more than this wallet can cover.");
    }
  }
  const finalError = await decodeSimError(finalSim.err, finalSim.logs ?? []);

  const verification = verifyInstructions(
    { payer: decoded.payerKey, instructions: decoded.instructions },
    { payer: decoded.payerKey, instructions },
  );
  for (const c of changes) {
    if (c.type === "compute_unit_limit" || c.type === "priority_fee" || c.type === "loaded_accounts_data_limit") {
      verification.changes.push({ kind: "compute_budget", program: "Transaction header (v1)", detail: `${c.type.replace(/_/g, " ")} ${c.after}` });
    }
  }
  if (!verification.ok) notes.unshift(`Internal verification refused this rebuild: ${verification.violations.join(" ")}`);
  const simulated = finalSim.err == null;
  const passed = simulated && verification.ok;
  if (passed && changes.some((c) => c.type === "compute_unit_limit" || c.type === "priority_fee" || c.type === "loaded_accounts_data_limit")) notes.unshift(v1Note);
  if (!changes.some((c) => c.type === "blockhash") && "blockhash" in decoded.lifetime) {
    notes.push("A fresh blockhash is always applied, so sign and send within about 60 seconds.");
  }
  notes.push("Simulation runs against current chain state. It proves the transaction executes now. It cannot guarantee inclusion if state changes before it lands.");
  if (passed && landed && !requoted && cause && SLIPPAGE_PATTERN.test(`${cause.title} ${cause.code ?? ""}`)) {
    const standing = await describeStandingQuote(instructions);
    if (standing) notes.unshift(standing);
  }
  const wasBroken = cause != null;
  return {
    status: passed ? (wasBroken ? "repaired" : "valid") : "not_repairable",
    summary: !passed
      ? simulated
        ? "A rebuild was produced and it simulates, but it failed TxWhy's own safety check, so it is withheld."
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
    repairedTransaction: passed ? final.base64 : null,
    verification: passed ? verification : undefined,
    simulation: { passed: simulated, unitsConsumed: finalSim.unitsConsumed ?? null, error: finalError, logsTail: (finalSim.logs ?? []).slice(-8) },
    notes,
  };
}
