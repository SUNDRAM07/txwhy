import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { rpc } from "./rpc";

/**
 * Slippage repair: rebuild a failed Jupiter swap from a fresh quote.
 *
 * The swap amounts live inside the instruction data, so a slippage failure cannot be
 * fixed by touching blockhash or fees. We read the user's original intent (tokens,
 * amount, slippage tolerance) out of the failed instruction, ask Jupiter for a current
 * route, and replace ONLY that one instruction. Every other instruction in the
 * transaction (memos, fee transfers, tips, account setup) is kept exactly as written,
 * in the same order. The tolerance the user chose is kept as is. We never widen it.
 */

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_API = process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag/swap/v1";

type Mode = "ExactIn" | "ExactOut";

interface Layout {
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
const LAYOUTS: Record<string, Layout> = {
  e517cb977ae3ad2a: { name: "route", mode: "ExactIn", user: 1, sourceMint: { tokenAccount: 2 }, destinationMint: 5, amounts: "tail", source: 2, destinations: [3, 4] },
  c1209b3341d69c81: { name: "shared_accounts_route", mode: "ExactIn", user: 2, sourceMint: 7, destinationMint: 8, amounts: "tail", source: 3, destinations: [6] },
  bb64facc31c4af14: { name: "route_v2", mode: "ExactIn", user: 0, sourceMint: 3, destinationMint: 4, amounts: 8, source: 1, destinations: [2, 7] },
  d19853937cfed8e9: { name: "shared_accounts_route_v2", mode: "ExactIn", user: 1, sourceMint: 6, destinationMint: 7, amounts: 9, source: 2, destinations: [5] },
  d033ef977b2bed5c: { name: "exact_out_route", mode: "ExactOut", user: 1, sourceMint: 5, destinationMint: 6, amounts: "tail", source: 2, destinations: [3, 4] },
  b0d169a89a7d453e: { name: "shared_accounts_exact_out_route", mode: "ExactOut", user: 2, sourceMint: 7, destinationMint: 8, amounts: "tail", source: 3, destinations: [6] },
  "9d8ab85215f4f324": { name: "exact_out_route_v2", mode: "ExactOut", user: 0, sourceMint: 3, destinationMint: 4, amounts: 8, source: 1, destinations: [2, 7] },
  "3560e5cad8bbfa18": { name: "shared_accounts_exact_out_route_v2", mode: "ExactOut", user: 1, sourceMint: 6, destinationMint: 7, amounts: 9, source: 2, destinations: [5] },
};

export interface SwapIntent {
  instruction: string;
  mode: Mode;
  user: string;
  inputMint: string;
  outputMint: string;
  /** The fixed side: input amount for ExactIn, output amount for ExactOut. Raw units. */
  amount: bigint;
  /** The quoted other side at the time the failed transaction was built. Raw units. */
  quotedOther: bigint;
  slippageBps: number;
}

export type RequoteOutcome =
  | {
      ok: true;
      /** The original instruction list with only the swap instruction replaced. */
      instructions: TransactionInstruction[];
      /** Lookup tables the new route needs, in addition to the original ones. */
      lookupTables: string[];
      intent: SwapIntent;
      before: string;
      after: string;
      notes: string[];
    }
  | {
      ok: false;
      reason: string;
      intent?: SwapIntent;
      /** True when no rebuild could ever help (for example circular arbitrage), as opposed to "try a fresh quote yourself". */
      final?: boolean;
    };

function readAmounts(data: Buffer, at: number | "tail") {
  const start = at === "tail" ? data.length - 19 : at;
  if (start < 8 || start + 18 > data.length) return null;
  return {
    first: data.readBigUInt64LE(start),
    second: data.readBigUInt64LE(start + 8),
    slippageBps: data.readUInt16LE(start + 16),
  };
}

async function mintOfTokenAccount(address: string): Promise<string | null> {
  const { value } = await rpc<{
    value: { data: { parsed?: { info?: { mint?: string } } } } | null;
  }>("getAccountInfo", [address, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return value?.data?.parsed?.info?.mint ?? null;
}

async function decimalsOf(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const { value } = await rpc<{
      value: ({ data: { parsed?: { info?: { decimals?: number } } } } | null)[];
    }>("getMultipleAccounts", [mints, { encoding: "jsonParsed", commitment: "confirmed" }]);
    value.forEach((acc, i) => {
      const d = acc?.data?.parsed?.info?.decimals;
      if (typeof d === "number") out.set(mints[i], d);
    });
  } catch {
    /* fall back to raw units */
  }
  return out;
}

/** Symbols for the most traded mints, so amounts read as money instead of addresses. */
const KNOWN_SYMBOLS: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP",
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": "PYUSD",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "WETH",
};

function human(raw: bigint, decimals: number | undefined, mint: string): string {
  const label = KNOWN_SYMBOLS[mint] ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  if (decimals == null) return `${raw} raw units of ${label}`;
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${whole}${frac ? "." + frac : ""} ${label}`;
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
    destinations: layout.destinations.map(at).join(","),
  };
}

/** Read the swap the user was trying to make out of a failed transaction's instructions. */
export async function readSwapIntent(
  instructions: TransactionInstruction[],
): Promise<{ intent?: SwapIntent; reason?: string }> {
  const jupiter = instructions.filter((ix) => ix.programId.toBase58() === JUPITER_V6);
  if (jupiter.length === 0) {
    return { reason: "The swap runs inside another program, so the route cannot be replaced from outside it." };
  }
  if (jupiter.length > 1) return { reason: "The transaction contains more than one swap instruction." };

  const ix = jupiter[0];
  const layout = LAYOUTS[Buffer.from(ix.data.subarray(0, 8)).toString("hex")];
  if (!layout) return { reason: "This Jupiter instruction type does not carry a fixed amount to re-quote." };
  const amounts = readAmounts(Buffer.from(ix.data), layout.amounts);
  if (!amounts) return { reason: "Could not read the swap amounts from the instruction." };

  const key = (i: number) => ix.keys[i]?.pubkey.toBase58();
  const user = key(layout.user);
  const outputMint = key(layout.destinationMint);
  const inputMint =
    typeof layout.sourceMint === "number"
      ? key(layout.sourceMint)
      : await mintOfTokenAccount(key(layout.sourceMint.tokenAccount) ?? "");
  if (!user || !inputMint || !outputMint) return { reason: "Could not resolve the swap's tokens." };

  const intent: SwapIntent = {
    instruction: layout.name,
    mode: layout.mode,
    user,
    inputMint,
    outputMint,
    amount: amounts.first,
    quotedOther: amounts.second,
    slippageBps: amounts.slippageBps,
  };
  return { intent };
}

async function jupiter<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.JUPITER_API_KEY) headers["x-api-key"] = process.env.JUPITER_API_KEY;
  const res = await fetch(`${JUPITER_API}${path}`, { ...init, headers, cache: "no-store" });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 160);
    throw new Error(`Jupiter responded ${res.status}${detail ? ": " + detail : ""}`);
  }
  return (await res.json()) as T;
}

interface Quote {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct?: string;
  routePlan?: { swapInfo?: { label?: string } }[];
}

interface JupiterInstruction {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
}

function toInstruction(ix: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(ix.data, "base64"),
  });
}

export async function requoteJupiter(instructions: TransactionInstruction[]): Promise<RequoteOutcome> {
  const { intent, reason } = await readSwapIntent(instructions);
  if (!intent) return { ok: false, reason: reason ?? "No swap found." };
  if (reason) return { ok: false, reason, intent };
  if (intent.inputMint === intent.outputMint) {
    return {
      ok: false,
      final: true,
      intent,
      reason:
        "This is a circular arbitrage: the same token goes in and comes out. It only succeeds while a price gap exists, and the gap had closed by the time it executed. Arbitrage transactions are built to fail this way, so there is nothing to repair.",
    };
  }

  let quote: Quote;
  let built: { setupInstructions?: JupiterInstruction[]; swapInstruction: JupiterInstruction; addressLookupTableAddresses?: string[] };
  try {
    const q = new URLSearchParams({
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amount: intent.amount.toString(),
      slippageBps: String(intent.slippageBps),
      swapMode: intent.mode,
    });
    quote = await jupiter<Quote>(`/quote?${q}`);
    // wrapAndUnwrapSol is off on purpose: the original transaction already carries its own
    // wrap and unwrap steps, and we keep those untouched.
    built = await jupiter("/swap-instructions", {
      method: "POST",
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: intent.user, wrapAndUnwrapSol: false }),
    });
    if (!built.swapInstruction) throw new Error("no swap instruction returned");
  } catch (e) {
    return {
      ok: false,
      intent,
      reason: `Could not get a fresh route (${e instanceof Error ? e.message : "quote service error"}).`,
    };
  }

  // Replace the one Jupiter instruction. Token-account creation that the new route needs is
  // idempotent, so it is safe to place directly before the swap.
  const replacement = [...(built.setupInstructions ?? []).map(toInstruction), toInstruction(built.swapInstruction)];
  const spliced = instructions.flatMap((ix) => (ix.programId.toBase58() === JUPITER_V6 ? replacement : [ix]));
  const kept = instructions.length - 1;

  const decimals = await decimalsOf([intent.inputMint, intent.outputMint]);
  const exactIn = intent.mode === "ExactIn";
  // The "other side": what you receive (ExactIn) or what you pay (ExactOut).
  const otherMint = exactIn ? intent.outputMint : intent.inputMint;
  const otherDecimals = decimals.get(otherMint);
  const bps = BigInt(intent.slippageBps);
  const oldLimit = exactIn
    ? (intent.quotedOther * (BigInt(10000) - bps)) / BigInt(10000)
    : (intent.quotedOther * (BigInt(10000) + bps)) / BigInt(10000);
  const newQuoted = BigInt(exactIn ? quote.outAmount : quote.inAmount);
  const newLimit = BigInt(quote.otherAmountThreshold);
  const word = exactIn ? "receive at least" : "pay at most";

  const moved = Number(((newQuoted - intent.quotedOther) * BigInt(100000)) / (intent.quotedOther || BigInt(1))) / 1000;
  const route = (quote.routePlan ?? []).map((s) => s.swapInfo?.label).filter(Boolean).join(" → ");
  const notes = [
    `Price moved ${moved > 0 ? "+" : ""}${moved.toFixed(2)}% on the ${exactIn ? "output" : "input"} side since the failed transaction was built. Your ${(intent.slippageBps / 100).toFixed(2)}% tolerance is unchanged.`,
    `You will now ${word} ${human(newLimit, otherDecimals, otherMint)}. Check that this is still a trade you want before signing.`,
  ];
  if (route) notes.push(`New route: ${route}.`);
  if (quote.priceImpactPct && Number(quote.priceImpactPct) > 0.01) {
    notes.push(`Price impact of the new route is ${(Number(quote.priceImpactPct) * 100).toFixed(2)}%.`);
  }

  notes.push(
    kept === 0
      ? "The transaction contained only the swap."
      : `Only the swap instruction was replaced. The other ${kept} instruction${kept === 1 ? " was" : "s were"} kept exactly as written, in the same order.`,
  );

  return {
    ok: true,
    instructions: spliced,
    lookupTables: built.addressLookupTableAddresses ?? [],
    intent,
    before: `${word} ${human(oldLimit, otherDecimals, otherMint)} (quoted ${human(intent.quotedOther, otherDecimals, otherMint)})`,
    after: `${word} ${human(newLimit, otherDecimals, otherMint)} (quoted ${human(newQuoted, otherDecimals, otherMint)})`,
    notes,
  };
}
