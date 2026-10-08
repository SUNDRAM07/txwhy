import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { readFailureHistory } from "@/lib/stats";

/**
 * The failure index over time: one point per hour for the last 30 days, cumulative counters per
 * program, free to reuse (CC BY 4.0). Subtract consecutive points to get per-hour rates.
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
  const history = await readFailureHistory();
  if (!history) return Response.json({ error: "The index is not available right now. Try again in a minute.", retryable: true }, { status: 503, headers: CORS });
  return Response.json(
    {
      ...history,
      about: {
        what: "Hourly snapshots of the TxWhy Solana failure index: cumulative transactions sampled and failed, overall and per program, plus the engine's replay counters.",
        how: "Each point is the counter value at the end of that hour (UTC). The failure rate for an hour is (failed[i] - failed[i-1]) / (seen[i] - seen[i-1]). Snapshots began on Oct 8, 2026.",
        fields: "t: hour (ISO, UTC); seen, failed: transactions sampled and failed so far; attempted, rebuilt: landed failures replayed through the engine and returned as working transactions; by: per program [seen, failed].",
        license: "CC BY 4.0. Cite as: TxWhy Solana failure index, https://txwhy.vercel.app/failures",
      },
    },
    { headers: { ...CORS, "cache-control": "public, max-age=300" } },
  );
}
