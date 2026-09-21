import { after } from "next/server";
import { clientKey, globalLimit, rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { RepairInputError, repair } from "@/lib/repair";
import { RpcError } from "@/lib/rpc";
import { track } from "@/lib/stats";
import { extractSignature } from "@/lib/trace";

export const maxDuration = 30;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-txwhy-client",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * POST /api/v1/repair
 * Body: { "signature": "<failed tx signature or explorer URL>" }
 *    or { "transaction": "<base64 serialized transaction, signed or unsigned>" }
 */
export async function POST(request: Request) {
  const limit = rateLimit(request, "repair", 30);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds, CORS);

  let body: { signature?: string; transaction?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400, headers: CORS });
  }

  const signature = body.signature ? extractSignature(body.signature) : null;
  if (body.signature && !signature) {
    return Response.json(
      { error: "That does not look like a transaction signature or explorer link." },
      { status: 400, headers: CORS },
    );
  }

  try {
    // Runs alongside the repair, so the global limit costs no time.
    const allowed = globalLimit(request, "repair", 60);
    const result = await repair({ signature: signature ?? undefined, transaction: body.transaction });
    const verdict = await allowed;
    if (!verdict.ok) return tooManyRequests(verdict.retryAfterSeconds, CORS);
    const client = request.headers.get("x-txwhy-client");
    // Our own test suite marks itself so public usage numbers only ever count real callers.
    if (client !== "test") {
      const caller = clientKey(request);
      // Counted after the response has gone out, so usage tracking never adds latency to a repair.
      after(() =>
        track({
          kind: "repair",
          channel: client === "web" || client === "sdk" || client === "cli" ? client : "api",
          status: result.status,
          errorTitle: result.cause?.title,
          caller,
        }),
      );
    }
    return Response.json(result, { headers: CORS });
  } catch (e) {
    if (e instanceof RepairInputError) {
      return Response.json({ error: e.message }, { status: 400, headers: CORS });
    }
    if (e instanceof RpcError) {
      return Response.json(
        { error: `Upstream RPC error: ${e.message}`, retryable: true },
        { status: 502, headers: CORS },
      );
    }
    return Response.json(
      { error: e instanceof Error ? e.message : "Unexpected error" },
      { status: 500, headers: CORS },
    );
  }
}
