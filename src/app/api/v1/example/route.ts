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
 * GET /api/v1/example?kind=compute|blockhash|slippage
 *
 * Builds a deliberately broken, UNSIGNED demo transaction so anyone can watch a repair
 * without owning a failed transaction. The fee payer is a public exchange wallet used
 * only so simulation has a funded account to run against. Nobody but its owner could
 * ever sign these, so they are safe to hand out.
 */

const DEMO_PAYER = new PublicKey("5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9");
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
