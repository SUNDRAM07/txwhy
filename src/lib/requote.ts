import { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { rpc } from "./rpc";

/**
 * Slippage repair: rebuild a failed Jupiter swap from a fresh quote.
 *
 * The swap amounts live inside the instruction data, so a slippage failure cannot be
 * fixed by touching blockhash or fees. We read the user's original intent (tokens,
 * amount, slippage tolerance) out of the failed instruction, ask Jupiter for a current
 * route, and return the new unsigned swap. The tolerance the user chose is kept as is.
 * We never widen it on their behalf.
 */

const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const JUPITER_API = process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag/swap/v1";

/** Programs a plain retail swap may contain besides Jupiter. Anything else means custom logic we must not drop. */
const PLAIN_SWAP_PROGRAMS = new Set([
  JUPITER_V6,
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

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
}

/** Verified against Jupiter v6's on-chain IDL (Sep 2026). Token-ledger variants carry no input amount and are not supported. */
const LAYOUTS: Record<string, Layout> = {
  e517cb977ae3ad2a: { name: "route", mode: "ExactIn", user: 1, sourceMint: { tokenAccount: 2 }, destinationMint: 5, amounts: "tail" },
  c1209b3341d69c81: { name: "shared_accounts_route", mode: "ExactIn", user: 2, sourceMint: 7, destinationMint: 8, amounts: "tail" },
  bb64facc31c4af14: { name: "route_v2", mode: "ExactIn", user: 0, sourceMint: 3, destinationMint: 4, amounts: 8 },
  d19853937cfed8e9: { name: "shared_accounts_route_v2", mode: "ExactIn", user: 1, sourceMint: 6, destinationMint: 7, amounts: 9 },
  d033ef977b2bed5c: { name: "exact_out_route", mode: "ExactOut", user: 1, sourceMint: 5, destinationMint: 6, amounts: "tail" },
  b0d169a89a7d453e: { name: "shared_accounts_exact_out_route", mode: "ExactOut", user: 2, sourceMint: 7, destinationMint: 8, amounts: "tail" },
  "9d8ab85215f4f324": { name: "exact_out_route_v2", mode: "ExactOut", user: 0, sourceMint: 3, destinationMint: 4, amounts: 8 },
  "3560e5cad8bbfa18": { name: "shared_accounts_exact_out_route_v2", mode: "ExactOut", user: 1, sourceMint: 6, destinationMint: 7, amounts: 9 },
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
  | { ok: true; transaction: VersionedTransaction; intent: SwapIntent; before: string; after: string; notes: string[] }
  | { ok: false; reason: string; intent?: SwapIntent };

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

/** Read the swap the user was trying to make out of a failed transaction's instructions. */
export async function readSwapIntent(
  instructions: TransactionInstruction[],
): Promise<{ intent?: SwapIntent; reason?: string }> {
  const foreign = instructions.find((ix) => !PLAIN_SWAP_PROGRAMS.has(ix.programId.toBase58()));
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
  if (foreign) {
    return {
      intent,
      reason: `The transaction also calls ${foreign.programId.toBase58()}, which a rebuilt swap would drop. Rebuild it in your own client with a fresh quote.`,
    };
  }
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

export async function requoteJupiter(
  instructions: TransactionInstruction[],
  payer: PublicKey,
): Promise<RequoteOutcome> {
  const { intent, reason } = await readSwapIntent(instructions);
  if (!intent) return { ok: false, reason: reason ?? "No swap found." };
  if (reason) return { ok: false, reason, intent };
  if (intent.inputMint === intent.outputMint) {
    return {
      ok: false,
      intent,
      reason:
        "This is a circular arbitrage: the same token goes in and comes out. It only succeeds while a price gap exists, and the gap closed. There is nothing to repair.",
    };
  }
  if (intent.user !== payer.toBase58()) {
    return {
      ok: false,
      intent,
      reason: "The fee payer is not the swapping wallet, so a rebuilt swap would change who pays. Rebuild it in your own client.",
    };
  }

  let quote: Quote;
  let swapTransaction: string;
  try {
    const q = new URLSearchParams({
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      amount: intent.amount.toString(),
      slippageBps: String(intent.slippageBps),
      swapMode: intent.mode,
    });
    quote = await jupiter<Quote>(`/quote?${q}`);
    const built = await jupiter<{ swapTransaction: string }>("/swap", {
      method: "POST",
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: intent.user,
        dynamicComputeUnitLimit: true,
        wrapAndUnwrapSol: true,
      }),
    });
    swapTransaction = built.swapTransaction;
  } catch (e) {
    return {
      ok: false,
      intent,
      reason: `Could not get a fresh route (${e instanceof Error ? e.message : "quote service error"}).`,
    };
  }

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

  return {
    ok: true,
    transaction: VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64")),
    intent,
    before: `${word} ${human(oldLimit, otherDecimals, otherMint)} (quoted ${human(intent.quotedOther, otherDecimals, otherMint)})`,
    after: `${word} ${human(newLimit, otherDecimals, otherMint)} (quoted ${human(newQuoted, otherDecimals, otherMint)})`,
    notes,
  };
}
