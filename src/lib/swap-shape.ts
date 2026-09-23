import type { TransactionInstruction } from "@solana/web3.js";

/**
 * Reads what a Jupiter v6 swap instruction asks for, from the instruction alone.
 * Pure and synchronous: no network, no environment. The verifier depends on this file
 * and on nothing else, so it can run anywhere, including offline.
 */

export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

export type Mode = "ExactIn" | "ExactOut";

export interface Layout {
  name: string;
  mode: Mode;
  /** Account index of the user's transfer authority. */
  user: number;
  /** Account index of the source mint, or of the user's source token account when the mint is not listed. */
  sourceMint: number | { tokenAccount: number };
  destinationMint: number;
  /** Where the amounts sit: a byte offset from the start of data, or "tail" (the last 19 bytes). */
  amounts: number | "tail";
  /** Account index of the token account the input is taken from. */
  source: number;
  /** Account indexes of every token account that can receive the output. */
  destinations: number[];
}

/** Verified against Jupiter v6's on-chain IDL (Sep 2026). Token-ledger variants carry no input amount and are not supported. */
export const LAYOUTS: Record<string, Layout> = {
  e517cb977ae3ad2a: { name: "route", mode: "ExactIn", user: 1, sourceMint: { tokenAccount: 2 }, destinationMint: 5, amounts: "tail", source: 2, destinations: [3, 4] },
  c1209b3341d69c81: { name: "shared_accounts_route", mode: "ExactIn", user: 2, sourceMint: 7, destinationMint: 8, amounts: "tail", source: 3, destinations: [6] },
  bb64facc31c4af14: { name: "route_v2", mode: "ExactIn", user: 0, sourceMint: 3, destinationMint: 4, amounts: 8, source: 1, destinations: [2, 7] },
  d19853937cfed8e9: { name: "shared_accounts_route_v2", mode: "ExactIn", user: 1, sourceMint: 6, destinationMint: 7, amounts: 9, source: 2, destinations: [5] },
  d033ef977b2bed5c: { name: "exact_out_route", mode: "ExactOut", user: 1, sourceMint: 5, destinationMint: 6, amounts: "tail", source: 2, destinations: [3, 4] },
  b0d169a89a7d453e: { name: "shared_accounts_exact_out_route", mode: "ExactOut", user: 2, sourceMint: 7, destinationMint: 8, amounts: "tail", source: 3, destinations: [6] },
  "9d8ab85215f4f324": { name: "exact_out_route_v2", mode: "ExactOut", user: 0, sourceMint: 3, destinationMint: 4, amounts: 8, source: 1, destinations: [2, 7] },
  "3560e5cad8bbfa18": { name: "shared_accounts_exact_out_route_v2", mode: "ExactOut", user: 1, sourceMint: 6, destinationMint: 7, amounts: 9, source: 2, destinations: [5] },
};

export function readAmounts(data: Buffer, at: number | "tail") {
  const start = at === "tail" ? data.length - 19 : at;
  if (start < 8 || start + 18 > data.length) return null;
  return {
    first: data.readBigUInt64LE(start),
    second: data.readBigUInt64LE(start + 8),
    slippageBps: data.readUInt16LE(start + 16),
  };
}

/**
 * The parts of a Jupiter swap that define what the user asked for, read synchronously from the
 * instruction alone. Used by the verifier to prove a replacement swap is the same trade.
 */
export function readSwapShape(ix: TransactionInstruction) {
  if (ix.programId.toBase58() !== JUPITER_V6) return null;
  const layout = LAYOUTS[Buffer.from(ix.data.subarray(0, 8)).toString("hex")];
  if (!layout) return null;
  const amounts = readAmounts(Buffer.from(ix.data), layout.amounts);
  const user = ix.keys[layout.user]?.pubkey.toBase58();
  const outputMint = ix.keys[layout.destinationMint]?.pubkey.toBase58();
  if (!amounts || !user || !outputMint) return null;
  const at = (i: number) => ix.keys[i]?.pubkey.toBase58() ?? "";
  return {
    // The instruction family must match too: a v2 swap may not be swapped for a different layout.
    instruction: layout.name,
    mode: layout.mode,
    user,
    outputMint,
    amount: amounts.first,
    slippageBps: amounts.slippageBps,
    /** Where the input comes from and where the output lands. These must never change. */
    source: at(layout.source),
    // Layouts list the destination in different slots, and an unused optional slot holds the
    // Jupiter program id as a placeholder. What matters is the one account that actually
    // receives the output: the optional override when present, otherwise the user's account.
    receiver: layout.destinations.map(at).filter((a) => a && a !== JUPITER_V6).pop() ?? "",
  };
}

/* ---------------------------------------------------------------------------------------------
 * Direct DEX swaps: Pump.fun bonding curve and PumpSwap AMM. Unlike Jupiter, these carry no
 * slippage tolerance: only an absolute limit (max cost for a buy, min output for a sell).
 * A repair keeps the fixed amount and every account, and moves only the limit.
 * ------------------------------------------------------------------------------------------- */

export const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export interface DirectLayout {
  program: "Pump.fun" | "PumpSwap";
  name: string;
  /** What the fixed argument is: tokens the user wants (buy), quote/SOL the user spends (buy_exact), tokens the user sells (sell). */
  fixed: "tokens_out" | "quote_in" | "tokens_in";
  /** What the limit argument is: a maximum the user pays, or a minimum the user receives. */
  limit: "max_in" | "min_out";
}

/** Discriminators from the programs' on-chain IDLs (Sep 2026). Both args are u64 at bytes 8 and 16. */
export const DIRECT_LAYOUTS: Record<string, Record<string, DirectLayout>> = {
  [PUMP_FUN]: {
    "66063d1201daebea": { program: "Pump.fun", name: "buy", fixed: "tokens_out", limit: "max_in" },
    b817ee6167c5d33d: { program: "Pump.fun", name: "buy_v2", fixed: "tokens_out", limit: "max_in" },
    "38fc74089edfcd5f": { program: "Pump.fun", name: "buy_exact_sol_in", fixed: "quote_in", limit: "min_out" },
    c2ab1c46684d5b2f: { program: "Pump.fun", name: "buy_exact_quote_in_v2", fixed: "quote_in", limit: "min_out" },
    "33e685a4017f83ad": { program: "Pump.fun", name: "sell", fixed: "tokens_in", limit: "min_out" },
    "5df6823ce7e940b2": { program: "Pump.fun", name: "sell_v2", fixed: "tokens_in", limit: "min_out" },
  },
  [PUMP_SWAP]: {
    "66063d1201daebea": { program: "PumpSwap", name: "buy", fixed: "tokens_out", limit: "max_in" },
    c62e1552b4d9e870: { program: "PumpSwap", name: "buy_exact_quote_in", fixed: "quote_in", limit: "min_out" },
    "33e685a4017f83ad": { program: "PumpSwap", name: "sell", fixed: "tokens_in", limit: "min_out" },
  },
};

/** A repaired limit may never be worse for the user than this factor of the original. */
export const DIRECT_LIMIT_CAP_BPS = 2_500;

export function readDirectSwapShape(ix: TransactionInstruction) {
  const layouts = DIRECT_LAYOUTS[ix.programId.toBase58()];
  if (!layouts || ix.data.length < 24) return null;
  const data = Buffer.from(ix.data);
  const layout = layouts[data.subarray(0, 8).toString("hex")];
  if (!layout) return null;
  return {
    ...layout,
    discriminator: data.subarray(0, 8).toString("hex"),
    amount: data.readBigUInt64LE(8),
    limitValue: data.readBigUInt64LE(16),
    accounts: ix.keys.map((k) => `${k.pubkey.toBase58()}:${k.isSigner ? "s" : ""}${k.isWritable ? "w" : ""}`),
    /** Everything after the two u64 args (flags such as track_volume) must stay byte for byte. */
    tail: data.subarray(24).toString("hex"),
  };
}

/**
 * True when `after` is the same direct swap as `before` with only the limit moved, and moved no
 * further against the user than the cap allows.
 */
export function isAllowedDirectLimitChange(before: ReturnType<typeof readDirectSwapShape>, after: ReturnType<typeof readDirectSwapShape>): { ok: boolean; reason?: string } {
  if (!before || !after) return { ok: false, reason: "not a recognised direct swap" };
  if (before.discriminator !== after.discriminator || before.program !== after.program) return { ok: false, reason: "the instruction kind" };
  if (before.amount !== after.amount) return { ok: false, reason: "the amount" };
  if (before.tail !== after.tail) return { ok: false, reason: "the instruction flags" };
  if (before.accounts.length !== after.accounts.length || before.accounts.some((a, i) => a !== after.accounts[i])) return { ok: false, reason: "the accounts" };
  const cap = BigInt(DIRECT_LIMIT_CAP_BPS);
  if (before.limit === "max_in") {
    const worst = before.limitValue + (before.limitValue * cap) / BigInt(10_000);
    if (after.limitValue > worst) return { ok: false, reason: `the maximum cost, by more than ${DIRECT_LIMIT_CAP_BPS / 100}%` };
  } else {
    const worst = before.limitValue - (before.limitValue * cap) / BigInt(10_000);
    if (after.limitValue < worst) return { ok: false, reason: `the minimum received, by more than ${DIRECT_LIMIT_CAP_BPS / 100}%` };
  }
  return { ok: true };
}
