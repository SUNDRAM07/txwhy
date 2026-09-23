import { OnlinePumpAmmSdk, buyBaseInput, buyQuoteInput, sellBaseInput } from "@pump-fun/pump-swap-sdk";
import { OnlinePumpSdk, getBuySolAmountFromTokenAmount, getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { RPC_URL } from "./rpc";
import { DIRECT_LIMIT_CAP_BPS, PUMP_FUN, PUMP_SWAP, readDirectSwapShape } from "./swap-shape";

/**
 * Slippage repair for direct Pump.fun (bonding curve) and PumpSwap (AMM) swaps.
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
  throw new Error("not a direct swap");
}

const label = (shape: { limit: "max_in" | "min_out" }) => (shape.limit === "max_in" ? "pay at most" : "receive at least");
const fmt = (v: bigint, unit: string) => (unit === "SOL" ? lamports(v) : `${v.toString()} ${unit}`);

/** Replace only the limit of the one direct swap in `instructions`. Returns the same list with that instruction rebuilt. */
export async function requoteDirect(instructions: TransactionInstruction[]): Promise<DirectRequoteOutcome> {
  const hit = findDirectSwap(instructions);
  if (!hit) {
    const direct = instructions.filter((ix) => readDirectSwapShape(ix)).length;
    return { ok: false, reason: direct > 1 ? "This transaction carries more than one Pump swap; TxWhy moves limits only when there is exactly one." : "The Pump swap is not a top-level instruction here: it runs inside another program by CPI, and TxWhy cannot move a limit that program computes." };
  }
  const { index, shape } = hit;
  const ix = instructions[index];
  let fresh: { limit: bigint; unit: string; expected: bigint };
  try {
    fresh = await freshLimit(ix, shape);
  } catch (e) {
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
  data.writeBigUInt64LE(fresh.limit, 16);
  const rebuilt = new (ix.constructor as typeof TransactionInstruction)({ programId: ix.programId, keys: ix.keys, data });
  const out = [...instructions];
  out[index] = rebuilt;
  return {
    ok: true,
    program: shape.program,
    instructions: out,
    before: `${label(shape)} ${fmt(shape.limitValue, fresh.unit)}`,
    after: `${label(shape)} ${fmt(fresh.limit, fresh.unit)} (now ${fmt(fresh.expected, fresh.unit)} at the current price, ${DIRECT_TOLERANCE_BPS / 100}% tolerance)`,
    notes: [
      `${shape.program} ${shape.name}: the amount (${shape.amount.toString()}) and every account are unchanged; only the ${shape.limit === "max_in" ? "maximum cost" : "minimum received"} moved to the current price plus a ${DIRECT_TOLERANCE_BPS / 100}% tolerance, computed with the program's own published math.`,
      `A limit is never moved more than ${DIRECT_LIMIT_CAP_BPS / 100}% against you.`,
    ],
  };
}
