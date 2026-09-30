import { createHash } from "node:crypto";

/**
 * Usage counters in Upstash Redis over its REST API (no SDK, no connection pool).
 * Everything here is optional: with no storage attached every call is a silent no-op,
 * and a slow or failing store can never slow down or break a repair.
 *
 * Privacy: we never store an IP address or a transaction. Unique callers are counted
 * with a HyperLogLog of salted hashes, which cannot be reversed or enumerated.
 */

const URL_ = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const SALT = process.env.STATS_SALT ?? "txwhy";

/** The always-on worker (Railway) holds the counters when configured. Upstash REST is the alternative. */
const WORKER_URL = process.env.WORKER_URL?.replace(/\/$/, "");
const WORKER_SECRET = process.env.WORKER_SECRET;
const useWorker = Boolean(WORKER_URL && WORKER_SECRET);

export const statsEnabled = useWorker || Boolean(URL_ && TOKEN);

export type Channel = "web" | "api" | "mcp" | "telegram" | "sdk" | "cli" | "x402";

type Command = (string | number)[];

async function pipeline(commands: Command[], timeoutMs = 900): Promise<unknown[] | null> {
  if (!statsEnabled || commands.length === 0) return null;
  try {
    const res = await fetch(`${URL_}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown }[];
    return body.map((r) => r.result ?? null);
  } catch {
    return null;
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export interface TrackEvent {
  kind: "diagnosis" | "repair";
  channel: Channel;
  /** Repair outcome, when kind is "repair". */
  status?: string;
  /** Named cause, used for the public "top failures" list. */
  errorTitle?: string | null;
  /** Anything that identifies the caller (an IP, a chat id). Hashed before it leaves this function. */
  caller?: string | null;
}

export async function track(event: TrackEvent): Promise<void> {
  if (!statsEnabled) return;
  if (useWorker) {
    try {
      await fetch(`${WORKER_URL}/track`, {
        method: "POST",
        headers: { authorization: `Bearer ${WORKER_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        cache: "no-store",
        signal: AbortSignal.timeout(900),
      });
    } catch {
      /* counting must never break a repair */
    }
    return;
  }
  const day = today();
  const commands: Command[] = [
    ["INCR", `s:total:${event.kind}`],
    ["INCR", `s:day:${day}:${event.kind}`],
    ["EXPIRE", `s:day:${day}:${event.kind}`, 60 * 60 * 24 * 120],
    ["HINCRBY", "s:channel", event.channel, 1],
  ];
  if (event.kind === "repair" && event.status) commands.push(["HINCRBY", "s:status", event.status, 1]);
  if (event.errorTitle && !/private program/.test(event.errorTitle)) {
    commands.push(["ZINCRBY", "s:errors", 1, event.errorTitle.slice(0, 80)]);
  }
  if (event.caller) {
    const hashed = createHash("sha256").update(`${SALT}:${event.caller}`).digest("hex").slice(0, 24);
    commands.push(["PFADD", "s:callers", hashed], ["PFADD", `s:callers:${day}`, hashed], ["EXPIRE", `s:callers:${day}`, 60 * 60 * 24 * 120]);
  }
  await pipeline(commands);
}

export interface Stats {
  diagnoses: number;
  repairs: number;
  repaired: number;
  callers: number;
  status: Record<string, number>;
  channel: Record<string, number>;
  topErrors: { title: string; count: number }[];
  days: { day: string; diagnoses: number; repairs: number }[];
}

function toRecord(flat: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(flat)) {
    for (let i = 0; i + 1 < flat.length; i += 2) out[String(flat[i])] = Number(flat[i + 1]);
  } else if (flat && typeof flat === "object") {
    for (const [k, v] of Object.entries(flat as Record<string, unknown>)) out[k] = Number(v);
  }
  return out;
}

export async function readStats(): Promise<Stats | null> {
  if (!statsEnabled) return null;
  if (useWorker) {
    try {
      const res = await fetch(`${WORKER_URL}/stats`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
      return res.ok ? ((await res.json()) as Stats) : null;
    } catch {
      return null;
    }
  }
  const dayKeys = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)).reverse();
  const result = await pipeline(
    [
      ["GET", "s:total:diagnosis"],
      ["GET", "s:total:repair"],
      ["PFCOUNT", "s:callers"],
      ["HGETALL", "s:status"],
      ["HGETALL", "s:channel"],
      ["ZREVRANGE", "s:errors", 0, 9, "WITHSCORES"],
      ...dayKeys.flatMap((d): Command[] => [
        ["GET", `s:day:${d}:diagnosis`],
        ["GET", `s:day:${d}:repair`],
      ]),
    ],
    2500,
  );
  if (!result) return null;
  const [diagnoses, repairs, callers, status, channel, errors, ...perDay] = result;
  const statusRecord = toRecord(status);
  const flatErrors = Array.isArray(errors) ? errors : [];
  const topErrors: { title: string; count: number }[] = [];
  for (let i = 0; i + 1 < flatErrors.length; i += 2) {
    topErrors.push({ title: String(flatErrors[i]), count: Number(flatErrors[i + 1]) });
  }
  return {
    diagnoses: Number(diagnoses ?? 0),
    repairs: Number(repairs ?? 0),
    repaired: (statusRecord.repaired ?? 0) + (statusRecord.valid ?? 0),
    callers: Number(callers ?? 0),
    status: statusRecord,
    channel: toRecord(channel),
    topErrors,
    days: dayKeys.map((day, i) => ({
      day,
      diagnoses: Number(perDay[i * 2] ?? 0),
      repairs: Number(perDay[i * 2 + 1] ?? 0),
    })),
  };
}

export interface FailureIndex {
  updatedAt: string | null;
  since: string | null;
  transactionsSeen: number;
  failed: number;
  failureRate: number;
  classified: number;
  source: Record<string, number>;
  byProgram: { program: string; seen: number; failed: number; failureRate: number }[];
  topCauses: { title: string; count: number }[];
  topCulprits: { program: string; count: number }[];
  /** The worker's own hit rate: sampled landed failures pushed through the repair engine. Absent on older workers. */
  repair?: {
    attempted: number;
    verdicts: Record<string, number>;
    repairedRate: number;
    averageMs: number;
    repairedByProgram: Record<string, number>;
    unrepairable: { title: string; count: number }[];
    movedTooFar: { title: string; count: number }[];
    engineErrors: { title: string; count: number }[];
    last: { at: string; program: string; verdict: string; detail: string | null; ms: number } | null;
    /** Attempts split into automated traders meant to fail and failures a person would care about. Absent on older workers. */
    segments?: { bots: number; people: number; rebuilt: number; movedTooFar: number; guards: number; deadEnds: number; rebuiltShareOfPeople: number };
  };
}

/** The worker's live sample of mainnet failures. Null when no worker is attached. */
export async function readFailureIndex(): Promise<FailureIndex | null> {
  if (!WORKER_URL) return null;
  try {
    const res = await fetch(`${WORKER_URL}/index`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()) as FailureIndex) : null;
  } catch {
    return null;
  }
}
