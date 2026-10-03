import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { readFailureIndex } from "@/lib/stats";

/**
 * The live Solana failure index as JSON, free to use: sampled transactions on nine of the busiest programs,
 * failure rates, named causes, who raised them, and TxWhy's own measured hit rate on those real failures.
 * A running sample, not a census. No addresses or transactions are stored or returned.
 */

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const limit = rateLimit(request, "index", 60);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds, CORS);
  const index = await readFailureIndex();
  if (!index) return Response.json({ error: "The index is not available right now. Try again in a minute.", retryable: true }, { status: 503, headers: CORS });
  return Response.json(
    {
      ...index,
      about: {
        what: "Running sample of failed Solana transactions on nine of the busiest programs, classified by the TxWhy decoder.",
        method: "Every 90 seconds the worker reads recent signatures per program, counts failures, classifies a slice, and pushes a sample through the TxWhy repair engine, recording only the verdict.",
        caveats: "A sample, not a census. 'repair' measures already-landed failures, the hard case: a floor for pre-send repair.",
        license: "CC BY 4.0. Cite as: TxWhy Solana failure index, https://txwhy.vercel.app/failures",
        page: "https://txwhy.vercel.app/failures",
      },
    },
    { headers: { ...CORS, "cache-control": "public, max-age=30" } },
  );
}
