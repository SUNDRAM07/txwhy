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
