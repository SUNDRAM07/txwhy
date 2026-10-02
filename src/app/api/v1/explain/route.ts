import { BodyError, readJson } from "@/lib/body";
import { decodeTransactionError } from "@/lib/errors";
import { fetchIdlErrors } from "@/lib/idl";
import { LIGHTHOUSE, base58ToBytes, lighthouseDetail } from "@/lib/lighthouse";
import { programName } from "@/lib/programs";
import { rateLimit, tooManyRequests } from "@/lib/ratelimit";
import { failureInfoFromLogs } from "@/lib/trace";

/**
 * Explain a simulation or send error without handing over the transaction.
 *
 * Wallets and apps already hold the RPC's answer when a transaction fails: the `err` object and the
 * program logs. This turns that into the same plain-words cause and fix TxWhy shows on its pages,
 * including wallet-guard (Lighthouse) decoding when the failing instruction's bytes are supplied.
 *
 *   POST /api/v1/explain
 *   { "error": <err from simulateTransaction / sendTransaction>, "logs": [...], "instruction": { "programId", "accounts": [...], "data": "<base58>" } }
 */

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-txwhy-client",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

interface ExplainBody {
  error?: unknown;
  logs?: unknown;
  instruction?: { programId?: unknown; accounts?: unknown; data?: unknown };
}

export async function POST(request: Request) {
  const limit = rateLimit(request, "explain", 60);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds, CORS);

  let body: ExplainBody;
  try {
    body = (await readJson(request, 64 * 1024)) as ExplainBody;
  } catch (e) {
    return Response.json({ error: e instanceof BodyError ? e.message : "Body must be JSON." }, { status: e instanceof BodyError ? e.status : 400, headers: CORS });
  }
  if (body.error === undefined || body.error === null) {
    return Response.json({ error: 'Provide "error": the err value from simulateTransaction or the transaction error, plus "logs" when you have them.' }, { status: 400, headers: CORS });
  }
  const logs = Array.isArray(body.logs) ? body.logs.filter((l): l is string => typeof l === "string").slice(0, 400) : [];

  const ix = body.instruction;
  const raw =
    ix && typeof ix.programId === "string" && typeof ix.data === "string"
      ? { programId: ix.programId, accounts: Array.isArray(ix.accounts) ? ix.accounts.filter((a): a is string => typeof a === "string") : [], data: base58ToBytes(ix.data) }
      : null;
  const guard = raw ? lighthouseDetail(body.error, () => raw) : null;

  const failingProgram = failureInfoFromLogs(logs).innermostFailedProgram ?? raw?.programId ?? null;
  const idlErrors = failingProgram && !guard ? await fetchIdlErrors(failingProgram).catch(() => null) : null;
  const cause = guard ?? decodeTransactionError(body.error, failingProgram, logs, idlErrors);
  const index = (body.error as { InstructionError?: [number, unknown] } | null)?.InstructionError?.[0];

  return Response.json(
    {
      cause,
      failingProgram: failingProgram ? { address: failingProgram, name: programName(failingProgram), isWalletGuard: failingProgram === LIGHTHOUSE } : null,
      failingInstruction: typeof index === "number" ? index : null,
      repairable: cause ? /slippage|compute|blockhash|loaded account|priority/i.test(`${cause.title} ${cause.cause}`) && !guard : false,
      next: guard
        ? "Build a fresh transaction in the app; the guard values are tied to the preview."
        : "To get a rebuilt transaction that passes, POST the unsigned base64 to /api/v1/repair.",
    },
    { headers: CORS },
  );
}
