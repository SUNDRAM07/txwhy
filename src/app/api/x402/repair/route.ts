import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { withX402 } from "@x402/next";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { NextResponse, type NextRequest } from "next/server";
import { after } from "next/server";
import { BodyError, REPAIR_BODY_LIMIT, readJson } from "@/lib/body";
import { rateLimit } from "@/lib/ratelimit";
import { RepairInputError, repair } from "@/lib/repair";
import { RPC_URL, RpcError } from "@/lib/rpc";
import { track } from "@/lib/stats";
import { extractSignature } from "@/lib/trace";

export const maxDuration = 30;

/**
 * POST /api/x402/repair: the same repair as /api/v1/repair, paid per call in USDC over x402.
 *
 * The free endpoint stays free and rate limited. This one has no rate limit: an agent that
 * needs guaranteed capacity pays PRICE per repair, settled on Solana by the facilitator, with
 * no account and no API key. The charge is only settled after a successful response, so a
 * failed request costs nothing.
 *
 * Enabled by setting X402_PAY_TO (the wallet that receives the USDC). Until then it answers 503.
 * That wallet MUST already hold a USDC token account (send it any amount of USDC once): the
 * x402 client transfers into the existing account and never creates it, so payments to a wallet
 * without one fail the facilitator's simulation.
 */
const PAY_TO = process.env.X402_PAY_TO;
const PRICE = process.env.X402_PRICE ?? "$0.001";
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-txwhy-client, payment-signature, x-payment",
  "access-control-expose-headers": "payment-required, payment-response, x-payment-response",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

async function handler(request: NextRequest): Promise<NextResponse> {
  const limit = rateLimit(request, "x402", 300);
  if (!limit.ok) return NextResponse.json({ error: "Too many requests. Slow down and retry.", retryable: true }, { status: 429, headers: CORS });
  let body: { signature?: string; transaction?: string };
  try {
    body = await readJson(request, REPAIR_BODY_LIMIT);
  } catch (e) {
    const status = e instanceof BodyError ? e.status : 400;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Bad request." }, { status, headers: CORS });
  }
  const signature = body.signature ? extractSignature(body.signature) : null;
  if (body.signature && !signature) {
    return NextResponse.json({ error: "That does not look like a transaction signature or explorer link." }, { status: 400, headers: CORS });
  }
  try {
    const result = await Promise.race([
      repair({ signature: signature ?? undefined, transaction: body.transaction }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new RpcError("upstream did not answer in time")), 26_000)),
    ]);
    if (request.headers.get("x-txwhy-client") !== "test") {
      after(() => track({ kind: "repair", channel: "x402", status: result.status, errorTitle: result.cause?.title }));
    }
    return NextResponse.json(result, { headers: CORS });
  } catch (e) {
    if (e instanceof RepairInputError) return NextResponse.json({ error: e.message }, { status: 400, headers: CORS });
    if (e instanceof RpcError) return NextResponse.json({ error: `Upstream RPC error: ${e.message}`, retryable: true }, { status: 502, headers: CORS });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unexpected error" }, { status: 500, headers: CORS });
  }
}

function build() {
  if (!PAY_TO) {
    return async () =>
      NextResponse.json(
        { error: "Paid repairs are not enabled on this deployment. The free endpoint is POST /api/v1/repair." },
        { status: 503, headers: CORS },
      );
  }
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR }));
  registerExactSvmScheme(server, { networks: [SOLANA_MAINNET], rpcUrl: RPC_URL });
  return withX402(
    handler,
    {
      accepts: { scheme: "exact", price: PRICE, network: SOLANA_MAINNET, payTo: PAY_TO, maxTimeoutSeconds: 60 },
      description: "Repair a failing Solana transaction: exact cause, rebuilt unsigned transaction, simulation proof, verification.",
      mimeType: "application/json",
      serviceName: "TxWhy",
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: { error: `Payment required: ${PRICE} in USDC on Solana per repair, settled only after a successful answer. The free, rate-limited endpoint is POST /api/v1/repair.` },
      }),
    },
    server,
  );
}

export const POST = build();
