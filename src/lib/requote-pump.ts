import { OnlinePumpAmmSdk, buyBaseInput, buyQuoteInput, sellBaseInput } from "@pump-fun/pump-swap-sdk";
import { OnlinePumpSdk, getBuySolAmountFromTokenAmount, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { RPC_URL } from "./rpc";
import { DIRECT_LIMIT_CAP_BPS, PUMP_FUN, PUMP_SWAP, RAYDIUM_V4, readDirectSwapShape, readSystemTransfer } from "./swap-shape";

/**
 * Slippage repair for direct Pump.fun (bonding curve), PumpSwap (AMM) and Raydium AMM v4 swaps.
 *
 * These instructions carry no slippage tolerance, only an absolute limit: the most quote/SOL a
 * buy may cost, or the least a sell/exact-in buy must return. When the price moves past that
 * limit the transaction fails, and no blockhash or fee change can help. The repair keeps the
 * amount the user fixed and every account, recomputes the limit from the pool's current state
 * with the programs' own published math (their SDKs, including the market-cap fee tiers), applies
 * a stated tolerance, and refuses to move the limit more than DIRECT_LIMIT_CAP_BPS against the
 * user. Nothing else in the transaction is touched.
 */

/** The tolerance applied to the fresh price. These instructions carry none of their own. */
export const DIRECT_TOLERANCE_BPS = 100;

export type DirectRequoteOutcome =
  | { ok: true; instructions: TransactionInstruction[]; before: string; after: string; notes: string[]; program: string }
  | { ok: false; reason: string; final?: boolean; /** The swap fits its own limit at the current price: whatever fails now is not slippage. */ fits?: boolean };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const bn = (v: bigint) => new BN(v.toString());
const big = (v: BN) => BigInt(v.toString());
const lamports = (v: bigint) => `${(Number(v) / 1e9).toFixed(6)} SOL`;
const withTolerance = (v: bigint, direction: "up" | "down") =>
  direction === "up" ? v + (v * BigInt(DIRECT_TOLERANCE_BPS)) / BigInt(10_000) : v - (v * BigInt(DIRECT_TOLERANCE_BPS)) / BigInt(10_000);

let connection: Connection | null = null;
const conn = () => (connection ??= new Connection(RPC_URL, "confirmed"));
let raydium: Promise<Raydium> | null = null;
const ray = () => (raydium ??= Raydium.load({ connection: conn(), disableLoadToken: true, disableFeatureCheck: true }));
const ceilDiv = (a: bigint, b: bigint) => (a + b - BigInt(1)) / b;

/** Find the one direct swap in the instruction list. Two would be ambiguous, and are refused. */
export function findDirectSwap(instructions: TransactionInstruction[]): { index: number; shape: NonNullable<ReturnType<typeof readDirectSwapShape>> } | null {
  const hits = instructions.map((ix, index) => ({ index, shape: readDirectSwapShape(ix) })).filter((h) => h.shape);
  if (hits.length !== 1) return null;
  return hits[0] as { index: number; shape: NonNullable<ReturnType<typeof readDirectSwapShape>> };
}

/** The fresh limit for the swap at the current pool state, in the instruction's own units. */
async function freshLimit(ix: TransactionInstruction, shape: NonNullable<ReturnType<typeof readDirectSwapShape>>): Promise<{ limit: bigint; unit: string; expected: bigint }> {
  const programId = ix.programId.toBase58();
  if (programId === PUMP_SWAP) {
    const sdk = new OnlinePumpAmmSdk(conn());
    const pool = ix.keys[0].pubkey;
    const user = ix.keys[1].pubkey;
    const state = await sdk.swapSolanaState(pool, user, ix.keys[5]?.pubkey, ix.keys[6]?.pubkey);
    const common = {
      slippage: DIRECT_TOLERANCE_BPS / 100,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
      quoteMint: state.pool.quoteMint,
      isMayhemMode: state.pool.isMayhemMode,
    };
    const unit = state.pool.quoteMint.toBase58() === SOL_MINT ? "SOL" : "quote";
    if (shape.name === "buy") {
      const q = buyBaseInput({ ...common, base: bn(shape.amount) });
      return { limit: big(q.maxQuote), expected: big(q.uiQuote), unit };
    }
    if (shape.name === "buy_exact_quote_in") {
      const q = buyQuoteInput({ ...common, quote: bn(shape.amount) });
      // The SDK returns the base received at the current price; the tolerance is applied here.
      return { limit: withTolerance(big(q.base), "down"), expected: big(q.base), unit: "tokens" };
    }
    const q = sellBaseInput({ ...common, base: bn(shape.amount) });
    return { limit: big(q.minQuote), expected: big(q.uiQuote), unit };
  }
  if (programId === PUMP_FUN) {
    const sdk = new OnlinePumpSdk(conn());
    // Both layouts put the mint at 2 (legacy) or the base mint at 1 (v2); the bonding curve is the account named so.
    const mint = shape.name.endsWith("_v2") || shape.name === "buy_exact_quote_in_v2" ? ix.keys[1].pubkey : ix.keys[2].pubkey;
    const [global, feeConfig, bondingCurve, quoteControl, supply] = await Promise.all([
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig().catch(() => null),
      sdk.fetchBondingCurve(mint),
      sdk.fetchQuoteControl().catch(() => null),
      conn().getTokenSupply(mint),
    ]);
    const mintSupply = new BN(supply.value.amount);
    const quoteMint = bondingCurve.quoteMint ?? new PublicKey(SOL_MINT);
    const unit = quoteMint.toBase58() === SOL_MINT ? "SOL" : "quote";
    if (shape.fixed === "tokens_out") {
      const cost = getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve, amount: bn(shape.amount), quoteMint, quoteControl, creatorFeeBps: bondingCurve.creatorFeeBps });
      return { limit: withTolerance(big(cost), "up"), expected: big(cost), unit };
    }
    if (shape.fixed === "quote_in") {
      const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve, amount: bn(shape.amount), quoteMint, quoteControl, creatorFeeBps: bondingCurve.creatorFeeBps });
      return { limit: withTolerance(big(tokens), "down"), expected: big(tokens), unit: "tokens" };
    }
    const out = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve, amount: bn(shape.amount) });
    return { limit: withTolerance(big(out), "down"), expected: big(out), unit };
  }
  if (programId === RAYDIUM_V4) {
    // Accounts: [1] amm, the user's source and destination token accounts are the last three with the owner.
    const amm = ix.keys[1].pubkey;
    const userSource = ix.keys[ix.keys.length - 3].pubkey;
    const [info, src] = await Promise.all([(await ray()).liquidity.getRpcPoolInfo(amm.toBase58()), conn().getParsedAccountInfo(userSource)]);
    const srcMint = (src.value?.data as { parsed?: { info?: { mint?: string } } })?.parsed?.info?.mint;
    if (!srcMint) throw new Error("could not read the source token account");
    const inIsBase = srcMint === info.baseMint.toBase58();
    if (!inIsBase && srcMint !== info.quoteMint.toBase58()) throw new Error("the source token account does not belong to this pool");
    const reserveIn = BigInt((inIsBase ? info.baseReserve : info.quoteReserve).toString());
    const reserveOut = BigInt((inIsBase ? info.quoteReserve : info.baseReserve).toString());
    const feeNum = BigInt(info.swapFeeNumerator.toString());
    const feeDen = BigInt(info.swapFeeDenominator.toString());
    const outMint = inIsBase ? info.quoteMint.toBase58() : info.baseMint.toBase58();
    const unitOf = (mint: string) => (mint === SOL_MINT ? "SOL" : "tokens");
    if (shape.name === "swap_base_in") {
      // Raydium v4: fee is taken from the input, then constant product.
      const fee = ceilDiv(shape.amount * feeNum, feeDen);
      const inAfterFee = shape.amount - fee;
      const out = (inAfterFee * reserveOut) / (reserveIn + inAfterFee);
      return { limit: withTolerance(out, "down"), expected: out, unit: unitOf(outMint) };
    }
    // swap_base_out: amount is the exact output; the limit is the most input the user pays.
    if (shape.amount >= reserveOut) throw new Error("the pool cannot supply that output amount");
    const inAfterFee = ceilDiv(shape.amount * reserveIn, reserveOut - shape.amount);
    const needed = ceilDiv(inAfterFee * feeDen, feeDen - feeNum);
    return { limit: withTolerance(needed, "up"), expected: needed, unit: unitOf(srcMint) };
  }
  throw new Error("not a direct swap");
}

const label = (shape: { limit: "max_in" | "min_out" }) => (shape.limit === "max_in" ? "pay at most" : "receive at least");
const fmt = (v: bigint, unit: string) => (unit === "SOL" ? lamports(v) : `${v.toString()} ${unit}`);

/** Replace only the limit of the one direct swap in `instructions`. Returns the same list with that instruction rebuilt. */
export interface RequoteHints {
  /** Logs of the failing simulation of the transaction as submitted. */
  logs?: string[];
  /** Simulates the whole transaction with these instructions in place of the originals and reports the token transfers it made. */
  probe?: (instructions: TransactionInstruction[]) => Promise<ProbeResult>;
}

export interface ProbeResult {
  err: unknown;
  /** One line naming the failure, when there was one. */
  errorTitle?: string;
  /** Every SPL token transfer the simulation executed by CPI. */
  transfers: { source: string; destination: string; amount: bigint; mint?: string }[];
}

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/**
 * Price a swap by asking the chain: simulate the same transaction with only this swap's limit lifted
 * (minimum 0, or maximum u64::MAX) and read what the program actually moved in or out of the user's
 * token account. No SDK math, so it cannot drift from the program's fee schedule. Used for programs
 * whose slippage check logs no numbers (Meteora).
 */
async function limitFromProbe(
  instructions: TransactionInstruction[],
  index: number,
  shape: NonNullable<ReturnType<typeof readDirectSwapShape>>,
  probe: NonNullable<RequoteHints["probe"]>,
): Promise<{ limit: bigint; unit: string; expected: bigint }> {
  const ix = instructions[index];
  const account = shape.limit === "min_out" ? shape.userOut : shape.userIn;
  const watched = account == null ? undefined : ix.keys[account]?.pubkey.toBase58();
  if (!watched) throw new Error("the swap does not list the user's token account where expected");
  const data = Buffer.from(ix.data);
  data.writeBigUInt64LE(shape.limit === "min_out" ? BigInt(0) : U64_MAX, shape.limitOffset);
  const lifted = [...instructions];
  lifted[index] = new (ix.constructor as typeof TransactionInstruction)({ programId: ix.programId, keys: ix.keys, data });
  const result = await probe(lifted);
  if (result.err != null && result.errorTitle === "PoolIsCompleted") {
    throw new NotSlippageError("this launch pool has completed its bonding curve and migrated, so no swap against it can succeed any more; trade the token on the pool it migrated to");
  }
  if (result.err != null) {
    throw new NotSlippageError(
      shape.limit === "max_in"
        ? `with the maximum lifted the transaction still fails (${result.errorTitle ?? "unknown error"}); an exact-output swap that wraps or holds only its original maximum cannot pay a higher price`
        : `with the minimum lifted the transaction still fails (${result.errorTitle ?? "unknown error"}), so slippage is not the only problem`,
    );
  }
  const moved = result.transfers.filter((t) => (shape.limit === "min_out" ? t.destination === watched : t.source === watched));
  const actual = moved.reduce((sum, t) => sum + t.amount, BigInt(0));
  if (actual === BigInt(0)) throw new Error("the simulation moved no tokens for the user");
  const unit = moved[0]?.mint === SOL_MINT ? "SOL" : "tokens";
  return { limit: withTolerance(actual, shape.limit === "max_in" ? "up" : "down"), expected: actual, unit };
}

class NotSlippageError extends Error {}

type Shape = NonNullable<ReturnType<typeof readDirectSwapShape>>;
const rebuild = (ix: TransactionInstruction, data: Buffer) => new (ix.constructor as typeof TransactionInstruction)({ programId: ix.programId, keys: ix.keys, data });
const withLamports = (ix: TransactionInstruction, amount: bigint) => {
  const data = Buffer.from(ix.data);
  data.writeBigUInt64LE(amount, 4);
  return rebuild(ix, data);
};

/** The one SOL transfer before the swap that funds the swap's own input token account (a wrap). */
function findWrap(instructions: TransactionInstruction[], index: number, shape: Shape): { index: number; lamports: bigint } | null {
  const input = shape.userIn == null ? undefined : instructions[index].keys[shape.userIn]?.pubkey.toBase58();
  if (!input) return null;
  const hits = instructions.slice(0, index).flatMap((ix, i) => {
    const t = readSystemTransfer(ix);
    return t && t.to === input ? [{ index: i, lamports: t.lamports }] : [];
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Exact-output swap funded by a wrap of exactly its maximum: raise the wrap and the maximum together
 * by the most the rules allow, simulate, and read what the swap really costs now.
 */
async function limitFromProbeWithWrap(
  instructions: TransactionInstruction[],
  index: number,
  shape: Shape,
  wrap: { index: number; lamports: bigint },
  probe: NonNullable<RequoteHints["probe"]>,
): Promise<{ limit: bigint; unit: string; expected: bigint }> {
  const cap = BigInt(DIRECT_LIMIT_CAP_BPS);
  const byLimit = (shape.limitValue * cap) / BigInt(10_000);
  const byWrap = (wrap.lamports * cap) / BigInt(10_000);
  const raise = byLimit < byWrap ? byLimit : byWrap;
  const ix = instructions[index];
  const input = ix.keys[shape.userIn as number].pubkey.toBase58();
  const data = Buffer.from(ix.data);
  data.writeBigUInt64LE(shape.limitValue + raise, shape.limitOffset);
  const lifted = [...instructions];
  lifted[index] = rebuild(ix, data);
  lifted[wrap.index] = withLamports(instructions[wrap.index], wrap.lamports + raise);
  const result = await probe(lifted);
  if (result.err != null) {
    throw new NotSlippageError(`with the wrapped SOL and the maximum both raised ${DIRECT_LIMIT_CAP_BPS / 100}%, the most a repair may move them, the transaction still fails (${result.errorTitle ?? "unknown error"})`);
  }
  const actual = result.transfers.filter((t) => t.source === input).reduce((sum, t) => sum + t.amount, BigInt(0));
  if (actual === BigInt(0)) throw new Error("the simulation moved no tokens for the user");
  const withRoom = withTolerance(actual, "up");
  const ceiling = shape.limitValue + raise;
  return { limit: withRoom < ceiling ? withRoom : ceiling, expected: actual, unit: "SOL" };
}

/**
 * The price the program itself computed, read from its own failed check. Anchor's require_gte!/require_gt!
 * log "Left: a" and "Right: b"; for a slippage check one side is the limit the transaction carried and the
 * other is the amount the program actually computed at current state. That amount is exact and immune to
 * fee-schedule changes the SDK has not caught up with, so it is preferred over SDK math when available.
 */
function limitFromLogs(shape: NonNullable<ReturnType<typeof readDirectSwapShape>>, logs: string[] | undefined): bigint | null {
  if (!logs?.length) return null;
  let left: bigint | null = null;
  let right: bigint | null = null;
  for (const line of logs) {
    const l = line.match(/^Program log: Left: (\d+)$/);
    const r = line.match(/^Program log: Right: (\d+)$/);
    if (l) left = BigInt(l[1]);
    if (r) right = BigInt(r[1]);
  }
  if (left != null && right != null) {
    if (left === shape.limitValue && right !== shape.limitValue) return right;
    if (right === shape.limitValue && left !== shape.limitValue) return left;
  }
  // Raydium AMM v4 logs the whole swap computation as base64 ("ray_log"): for swap_base_in the last field is
  // the output it computed; for swap_base_out it is the input it would deduct. Both are exact at current state.
  if (shape.program === "Raydium AMM v4") {
    const line = [...logs].reverse().find((l) => l.includes("ray_log: "));
    const b64 = line?.split("ray_log: ")[1]?.trim();
    if (b64) {
      try {
        const buf = Buffer.from(b64, "base64");
        const u64 = (at: number) => buf.readBigUInt64LE(at);
        if (buf.length >= 57 && buf[0] === 3 && shape.limit === "min_out" && u64(9) === shape.limitValue) return u64(49); // out_amount
        if (buf.length >= 57 && buf[0] === 4 && shape.limit === "max_in" && u64(1) === shape.limitValue) return u64(49); // deduct_in
      } catch {
        /* fall through to SDK math */
      }
    }
  }
  return null;
}

export async function requoteDirect(instructions: TransactionInstruction[], hints: RequoteHints = {}): Promise<DirectRequoteOutcome> {
  const hit = findDirectSwap(instructions);
  if (!hit) {
    const direct = instructions.filter((ix) => readDirectSwapShape(ix)).length;
    return { ok: false, reason: direct > 1 ? "This transaction carries more than one direct swap; TxWhy moves limits only when there is exactly one." : "The swap is not a top-level instruction here: it runs inside another program by CPI, and TxWhy cannot move a limit that program computes." };
  }
  const { index, shape } = hit;
  const ix = instructions[index];
  let fresh: { limit: bigint; unit: string; expected: bigint };
  let pricedBy = "the program's own published math";
  let wrap: { index: number; lamports: bigint } | null = null;
  try {
    const actual = limitFromLogs(shape, hints.logs);
    if (actual != null) {
      const quoteMint = ix.programId.toBase58() === PUMP_SWAP ? ix.keys[4]?.pubkey.toBase58() : SOL_MINT;
      const unit = shape.fixed === "quote_in" ? "tokens" : quoteMint === SOL_MINT ? "SOL" : "quote";
      fresh = { limit: withTolerance(actual, shape.limit === "max_in" ? "up" : "down"), expected: actual, unit };
      pricedBy = "the program's own check in the failing simulation";
    } else if (shape.userOut != null && hints.probe) {
      pricedBy = "a simulation of this same transaction with the limit lifted";
      try {
        fresh = await limitFromProbe(instructions, index, shape, hints.probe);
      } catch (e) {
        const funding = e instanceof NotSlippageError && shape.limit === "max_in" ? findWrap(instructions, index, shape) : null;
        if (!funding) throw e;
        fresh = await limitFromProbeWithWrap(instructions, index, shape, funding, hints.probe);
        wrap = funding;
      }
    } else {
      fresh = await freshLimit(ix, shape);
    }
  } catch (e) {
    if (e instanceof NotSlippageError) return { ok: false, reason: `The ${shape.program} ${shape.name} cannot be repaired by moving its limit: ${e.message}.` };
    return { ok: false, reason: `Could not price the ${shape.program} swap from the pool's current state (${e instanceof Error ? e.message : "unknown error"}).` };
  }
  const cap = BigInt(DIRECT_LIMIT_CAP_BPS);
  const worst = shape.limit === "max_in" ? shape.limitValue + (shape.limitValue * cap) / BigInt(10_000) : shape.limitValue - (shape.limitValue * cap) / BigInt(10_000);
  const beyondCap = shape.limit === "max_in" ? fresh.limit > worst : fresh.limit < worst;
  if (beyondCap) {
    return {
      ok: false,
      final: true,
      reason: `The price has moved more than ${DIRECT_LIMIT_CAP_BPS / 100}% against this trade since it was built (${shape.limit === "max_in" ? "it would now cost" : "it would now return"} ${fmt(fresh.expected, fresh.unit)} against a limit of ${fmt(shape.limitValue, fresh.unit)}). TxWhy will not move a limit that far; decide the new price yourself.`,
    };
  }
  const stillFine = shape.limit === "max_in" ? fresh.limit <= shape.limitValue : fresh.limit >= shape.limitValue;
  if (stillFine) {
    return { ok: false, fits: true, reason: `The ${shape.program} ${shape.name} fits its own limit at the current price (${label(shape)} ${fmt(shape.limitValue, fresh.unit)}, now ${fmt(fresh.expected, fresh.unit)}), so what fails now is not slippage.` };
  }
  const data = Buffer.from(ix.data);
  data.writeBigUInt64LE(fresh.limit, shape.limitOffset);
  const rebuilt = new (ix.constructor as typeof TransactionInstruction)({ programId: ix.programId, keys: ix.keys, data });
  const out = [...instructions];
  out[index] = rebuilt;
  const wrapNotes: string[] = [];
  if (wrap && fresh.limit > shape.limitValue) {
    const raised = wrap.lamports + (fresh.limit - shape.limitValue);
    out[wrap.index] = withLamports(instructions[wrap.index], raised);
    wrapNotes.push(
      `This transaction wraps exactly its maximum cost in SOL before the swap, so the wrap was raised by the same amount as the maximum (${lamports(wrap.lamports)} -> ${lamports(raised)}). It goes to your own wrapped-SOL account, and whatever the swap does not use stays there.`,
    );
  }
  return {
    ok: true,
    program: shape.program,
    instructions: out,
    before: `${label(shape)} ${fmt(shape.limitValue, fresh.unit)}`,
    after: `${label(shape)} ${fmt(fresh.limit, fresh.unit)} (now ${fmt(fresh.expected, fresh.unit)} at the current price, ${DIRECT_TOLERANCE_BPS / 100}% tolerance)`,
    notes: [
      `${shape.program} ${shape.name}: the amount (${shape.amount.toString()}) and every account are unchanged; only the ${shape.limit === "max_in" ? "maximum cost" : "minimum received"} moved to the current price plus a ${DIRECT_TOLERANCE_BPS / 100}% tolerance, computed with ${pricedBy}.`,
      ...wrapNotes,
      `A limit is never moved more than ${DIRECT_LIMIT_CAP_BPS / 100}% against you.`,
    ],
  };
}
