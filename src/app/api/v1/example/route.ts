import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { rpc } from "@/lib/rpc";
import { buildV1 } from "@/lib/v1";
import { buildStalePumpSwapBuy, buildStaleRaydiumSwap } from "@/lib/pump-demo";

/**
 * GET /api/v1/example?kind=compute|blockhash|slippage|impact|pump|raydium|v1
 *
 * Builds a deliberately broken, UNSIGNED demo transaction so anyone can watch a repair
 * without owning a failed transaction. The fee payer is a public exchange wallet used
 * only so simulation has a funded account to run against. Nobody but its owner could
 * ever sign these, so they are safe to hand out.
 */

const DEMO_PAYER = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");

interface ThinQuote {
  mint: string;
  impact: number;
  quote: { outAmount: string; otherAmountThreshold: string; priceImpactPct?: string };
}
let thinCache: { at: number; value: ThinQuote | null } | null = null;

/** A token where a 2 SOL buy already carries 5% to 60% price impact on Jupiter (well past the 3% refusal line), picked from the hour's trending list. */
async function findThinToken(): Promise<ThinQuote | null> {
  if (thinCache && Date.now() - thinCache.at < 5 * 60_000 && thinCache.value) return thinCache.value;
  let candidates: string[] = [];
  try {
    const trending = (await (await fetch("https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=40", { cache: "no-store" })).json()) as { id?: string }[];
    candidates = trending.map((t) => t.id).filter((id): id is string => typeof id === "string" && id !== SOL);
  } catch {
    candidates = [];
  }
  for (const mint of candidates.slice(0, 25)) {
    try {
      const quote = (await (await fetch(`${JUPITER_API}/quote?inputMint=${SOL}&outputMint=${mint}&amount=2000000000&slippageBps=50`, { cache: "no-store" })).json()) as ThinQuote["quote"] & { error?: string };
      const impact = Number(quote.priceImpactPct ?? 0) * 100;
      if (!quote.error && quote.outAmount && impact > 5 && impact < 60) {
        thinCache = { at: Date.now(), value: { mint, impact, quote } };
        return thinCache.value;
      }
    } catch {
      /* next candidate */
    }
  }
  thinCache = { at: Date.now(), value: null };
  return null;
}
const DEMO_RECIPIENT = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const EXPIRED_BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const JUPITER_API = process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag/swap/v1";
const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function encode(blockhash: string, instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: DEMO_PAYER,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

export async function GET(request: Request) {
  const limit = rateLimit(request, "example", 12);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const kind = new URL(request.url).searchParams.get("kind") ?? "compute";
  const transfer = SystemProgram.transfer({
    fromPubkey: DEMO_PAYER,
    toPubkey: DEMO_RECIPIENT,
    lamports: 1000,
  });

  try {
    if (kind === "blockhash") {
      return Response.json({
        kind,
        description: "A transfer built with a blockhash that expired long ago.",
        transaction: encode(EXPIRED_BLOCKHASH, [transfer]),
      });
    }

    if (kind === "impact") {
      // A 2 SOL buy of a thin token built on a stale quote: it fails on slippage, and the only fresh
      // route carries more than 3% price impact, so the engine refuses to return a repair. This is
      // the refusal itself as a demo: a repair you should not sign is worse than no repair.
      const thin = await findThinToken();
      if (!thin) throw new Error("No thin pool found right now; try again in a minute.");
      const stale = {
        ...thin.quote,
        outAmount: String(Math.floor(Number(thin.quote.outAmount) * 1.05)),
        otherAmountThreshold: String(Math.floor(Number(thin.quote.otherAmountThreshold) * 1.05)),
      };
      const built = await (
        await fetch(`${JUPITER_API}/swap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ quoteResponse: stale, userPublicKey: DEMO_PAYER.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: false }),
          cache: "no-store",
        })
      ).json();
      if (!built.swapTransaction) throw new Error("Could not build the demo swap.");
      return Response.json({
        kind,
        description: `A 2 SOL buy of ${thin.mint.slice(0, 4)}…${thin.mint.slice(-4)} on a stale quote. It fails on slippage, and the only fresh route has ${thin.impact.toFixed(1)}% price impact, so TxWhy refuses to repair it.`,
        transaction: built.swapTransaction,
      });
    }

    if (kind === "slippage") {
      const quoteRes = await fetch(
        `${JUPITER_API}/quote?inputMint=${SOL}&outputMint=${USDC}&amount=50000000&slippageBps=50`,
        { cache: "no-store" },
      );
      const quote = await quoteRes.json();
      // Inflate the expected output by 5% so the swap fails exactly the way a stale quote does.
      const stale = {
        ...quote,
        outAmount: String(Math.floor(Number(quote.outAmount) * 1.05)),
        otherAmountThreshold: String(Math.floor(Number(quote.otherAmountThreshold) * 1.05)),
      };
      const built = await (
        await fetch(`${JUPITER_API}/swap`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            quoteResponse: stale,
            userPublicKey: DEMO_PAYER.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: false,
          }),
          cache: "no-store",
        })
      ).json();
      if (!built.swapTransaction) throw new Error("Could not build the demo swap.");
      return Response.json({
        kind,
        description: "A 0.05 SOL to USDC swap built on a stale quote, so it fails on slippage.",
        transaction: built.swapTransaction,
      });
    }

    const { value } = await rpc<{ value: { blockhash: string } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    if (kind === "pump") {
      const { instructions, description } = await buildStalePumpSwapBuy(DEMO_PAYER);
      return Response.json({
        kind,
        description,
        transaction: encode(value.blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions]),
      });
    }
    if (kind === "raydium") {
      const { instructions, description } = await buildStaleRaydiumSwap(DEMO_PAYER);
      return Response.json({
        kind,
        description,
        transaction: encode(value.blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...instructions]),
      });
    }
    if (kind === "v1") {
      // A version 1 transaction (SIMD-0385): compute settings live in the header. This one has a
      // limit far too low and no loaded-data limit, which in v1 means zero bytes.
      return Response.json({
        kind,
        description: "A version 1 transaction (the new format, live since Sep 15) with a compute limit far too low and no loaded-data limit.",
        transaction: buildV1(DEMO_PAYER, value.blockhash, [transfer], { computeUnitLimit: 100 }),
      });
    }
    return Response.json({
      kind: "compute",
      description: "A transfer whose compute-unit limit is set far too low.",
      transaction: encode(value.blockhash, [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100 }),
        transfer,
      ]),
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Could not build the example." },
      { status: 502 },
    );
  }
}
