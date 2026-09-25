/**
 * TxWhy worker. A small always-on service for the two things a serverless site cannot do:
 *
 *   1. Hold the usage counters (POST /track, GET /stats) and the global rate limits (POST /limit).
 *   2. Watch mainnet: sample failed transactions from the busiest programs around the clock,
 *      classify each with the same decoder the site uses, and publish a live failure index
 *      (GET /index).
 *
 * Storage is Redis when REDIS_URL is set, otherwise in-memory (fine for local runs).
 * Nothing private is stored: no addresses, no transactions, no IPs.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createClient } from "redis";
import { decodeTransactionError } from "../src/lib/errors";
import { fetchIdlErrors } from "../src/lib/idl";
import { RepairInputError, repair } from "../src/lib/repair";
import { isNamedProgram, programName } from "../src/lib/programs";

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = process.env.WORKER_SECRET ?? "";
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SALT = process.env.STATS_SALT ?? "txwhy";
const POLL_MS = Number(process.env.INDEX_POLL_MS ?? 90_000);
const SAMPLE_PER_PROGRAM = Number(process.env.INDEX_SAMPLE ?? 4);
/** Real failures per program per pass that are pushed through the repair engine to measure our own hit rate. */
const REPAIR_SAMPLE = Number(process.env.INDEX_REPAIR_SAMPLE ?? 1);

const WATCHED: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
};

// ---------------------------------------------------------------- storage

interface Store {
  incr(key: string, by?: number): Promise<void>;
  hincr(key: string, field: string, by?: number): Promise<void>;
  zincr(key: string, member: string, by?: number): Promise<void>;
  pfadd(key: string, member: string): Promise<void>;
  get(key: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, number>>;
  ztop(key: string, n: number): Promise<{ member: string; score: number }[]>;
  pfcount(key: string): Promise<number>;
  getStr(key: string): Promise<string | null>;
  setStr(key: string, value: string): Promise<void>;
  /** Fixed-window counter: increments and returns the count, expiring the key when the window ends. */
  hit(key: string, windowSeconds: number): Promise<number>;
  /** Delete every key with this prefix. Used once, to clear pre-launch test traffic. */
  clear(prefix: string): Promise<number>;
}

function memoryStore(): Store {
  const nums = new Map<string, number>();
  const hashes = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const strs = new Map<string, string>();
  const windows = new Map<string, { n: number; until: number }>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  return {
    async incr(k, by = 1) { nums.set(k, (nums.get(k) ?? 0) + by); },
    async hincr(k, f, by = 1) { h(k).set(f, (h(k).get(f) ?? 0) + by); },
    async zincr(k, m, by = 1) { h(`z:${k}`).set(m, (h(`z:${k}`).get(m) ?? 0) + by); },
    async pfadd(k, m) { (sets.get(k) ?? sets.set(k, new Set()).get(k)!).add(m); },
    async get(k) { return nums.get(k) ?? 0; },
    async hgetall(k) { return Object.fromEntries(h(k)); },
    async ztop(k, n) { return [...h(`z:${k}`)].map(([member, score]) => ({ member, score })).sort((a, b) => b.score - a.score).slice(0, n); },
    async pfcount(k) { return sets.get(k)?.size ?? 0; },
    async getStr(k) { return strs.get(k) ?? null; },
    async setStr(k, v) { strs.set(k, v); },
    async hit(k, windowSeconds) {
      const now = Date.now();
      const w = windows.get(k);
      if (!w || w.until < now) {
        if (windows.size > 50_000) windows.clear();
        windows.set(k, { n: 1, until: now + windowSeconds * 1000 });
        return 1;
      }
      return ++w.n;
    },
    async clear(prefix) {
      let n = 0;
      for (const m of [nums, hashes, sets, strs] as Map<string, unknown>[]) {
        for (const k of [...m.keys()]) if (k.startsWith(prefix) || k.startsWith(`z:${prefix}`)) { m.delete(k); n++; }
      }
      return n;
    },
  };
}

async function redisStore(url: string): Promise<Store> {
  const client = createClient({ url });
  client.on("error", (e) => console.error("redis:", e.message));
  await client.connect();
  return {
    async incr(k, by = 1) { await client.incrBy(k, by); },
    async hincr(k, f, by = 1) { await client.hIncrBy(k, f, by); },
    async zincr(k, m, by = 1) { await client.zIncrBy(k, by, m); },
    async pfadd(k, m) { await client.pfAdd(k, m); },
    async get(k) { return Number((await client.get(k)) ?? 0); },
    async hgetall(k) { return Object.fromEntries(Object.entries(await client.hGetAll(k)).map(([f, v]) => [f, Number(v)])); },
    async ztop(k, n) { return (await client.zRangeWithScores(k, 0, n - 1, { REV: true })).map((r) => ({ member: r.value, score: r.score })); },
    async pfcount(k) { return client.pfCount(k); },
    async getStr(k) { return client.get(k); },
    async setStr(k, v) { await client.set(k, v); },
    async hit(k, windowSeconds) {
      const n = await client.incr(k);
      if (n === 1) await client.expire(k, windowSeconds);
      return n;
    },
    async clear(prefix) {
      const keys: string[] = [];
      for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) keys.push(...(Array.isArray(batch) ? batch : [batch]));
      if (keys.length) await client.del(keys);
      return keys.length;
    },
  };
}

// ---------------------------------------------------------------- usage counters

const today = () => new Date().toISOString().slice(0, 10);

interface TrackEvent {
  kind: "diagnosis" | "repair";
  channel: string;
  status?: string;
  errorTitle?: string | null;
  caller?: string | null;
}

async function track(store: Store, e: TrackEvent) {
  if (e.kind !== "diagnosis" && e.kind !== "repair") return;
  const day = today();
  await store.incr(`s:total:${e.kind}`);
  await store.incr(`s:day:${day}:${e.kind}`);
  await store.hincr("s:channel", String(e.channel).slice(0, 20));
  if (e.kind === "repair" && e.status) await store.hincr("s:status", String(e.status).slice(0, 24));
  if (e.errorTitle && !/private program/.test(e.errorTitle)) await store.zincr("s:errors", e.errorTitle.slice(0, 80));
  if (e.caller) {
    const hashed = createHash("sha256").update(`${SALT}:${e.caller}`).digest("hex").slice(0, 24);
    await store.pfadd("s:callers", hashed);
  }
}

async function readStats(store: Store) {
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)).reverse();
  const status = await store.hgetall("s:status");
  return {
    diagnoses: await store.get("s:total:diagnosis"),
    repairs: await store.get("s:total:repair"),
    repaired: (status.repaired ?? 0) + (status.valid ?? 0),
    callers: await store.pfcount("s:callers"),
    status,
    channel: await store.hgetall("s:channel"),
    topErrors: (await store.ztop("s:errors", 10)).map((r) => ({ title: r.member, count: r.score })),
    days: await Promise.all(days.map(async (day) => ({ day, diagnoses: await store.get(`s:day:${day}:diagnosis`), repairs: await store.get(`s:day:${day}:repair`) }))),
  };
}

// ---------------------------------------------------------------- mainnet failure index

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      const body = (await res.json()) as { result?: T };
      return body.result ?? null;
    } catch {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  return null;
}

interface SigInfo { signature: string; err: unknown }
interface TxInfo { meta: { err: unknown; logMessages?: string[] } | null }

function innermostFailedProgram(logs: string[]): string | null {
  for (const line of logs) {
    const m = line.match(/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/);
    if (m) return m[1];
  }
  return null;
}

async function sampleOnce(store: Store) {
  for (const [programId, label] of Object.entries(WATCHED)) {
    const last = await store.getStr(`i:cursor:${programId}`);
    const sigs = await rpc<SigInfo[]>("getSignaturesForAddress", [programId, { limit: 200, ...(last ? { until: last } : {}) }]);
    if (!sigs || sigs.length === 0) continue;
    await store.setStr(`i:cursor:${programId}`, sigs[0].signature);

    const failed = sigs.filter((s) => s.err);
    await store.incr("i:seen", sigs.length);
    await store.incr("i:failed", failed.length);
    await store.hincr("i:seen_by_program", label, sigs.length);
    await store.hincr("i:failed_by_program", label, failed.length);

    // Classify a sample. Fetching every failure would burn the RPC for no extra insight.
    for (const s of failed.slice(0, SAMPLE_PER_PROGRAM)) {
      const tx = await rpc<TxInfo>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
      const logs = tx?.meta?.logMessages ?? [];
      const culprit = innermostFailedProgram(logs);
      // Same layers as the site: the program's on-chain IDL first, then the bundled tables.
      const idlErrors = culprit && isNamedProgram(culprit) ? await fetchIdlErrors(culprit) : null;
      const decoded = decodeTransactionError(s.err, culprit, logs, idlErrors);
      await store.incr("i:classified");
      const isPrivate = culprit != null && !isNamedProgram(culprit);
      await store.hincr("i:source", isPrivate ? "private program" : "known program");
      if (!isPrivate && decoded?.title) await store.zincr("i:causes", decoded.title.slice(0, 80));
      if (culprit) await store.zincr("i:culprits", isPrivate ? "Private programs (unnamed)" : programName(culprit));
      await new Promise((r) => setTimeout(r, 700));
    }

    // Could TxWhy have fixed it? Push a few of the same real failures through the engine and keep the verdicts.
    // This is the live, honest measurement of our own hit rate, and the ranked list of what we do not handle yet.
    for (const s of failed.slice(0, REPAIR_SAMPLE)) {
      await attemptRepair(store, label, s.signature);
      await new Promise((r) => setTimeout(r, 500));
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  await store.setStr("i:updated", new Date().toISOString());
}

/** "Title: reason" with numbers and addresses blanked, so the same kind of failure lands on the same row of the ranked list. */
function reasonKey(title: string | undefined, summary: string): string {
  const reason = summary.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "…").replace(/[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/g, "…").replace(/-?\d[\d.,]*\s?%?/g, "N");
  // Every private-program error is the same story for us (no published error list), so they share one row.
  const t = /from a private program/i.test(title ?? "") ? "Private program (unnamed)" : (title ?? "").replace(/\([^)]*\)/g, "").trim();
  return `${t ? `${t}: ` : ""}${reason}`.slice(0, 120);
}

/** Runs one landed failure through the repair engine and records only the verdict. Nothing about the transaction is stored. */
async function attemptRepair(store: Store, program: string, signature: string) {
  const started = Date.now();
  let verdict: string;
  let detail: string | null = null;
  try {
    const result = await repair({ signature });
    if (result.status === "repaired" && result.verification?.ok && result.simulation.passed) verdict = "repaired";
    else if (result.status === "repaired") verdict = "repaired_unverified";
    else if (result.status === "valid") verdict = "valid";
    else if (result.status === "needs_requote") verdict = "moved_too_far";
    else verdict = "not_repairable";
    if (verdict === "not_repairable" || verdict === "moved_too_far") detail = reasonKey(result.cause?.title, result.summary);
  } catch (e) {
    if (e instanceof RepairInputError) {
      verdict = "not_repairable";
      detail = e.message.slice(0, 80);
    } else {
      verdict = "engine_error";
      detail = (e instanceof Error ? e.message : String(e)).slice(0, 80);
    }
  }
  const ms = Date.now() - started;
  await store.incr("i:repair:attempted");
  await store.incr("i:repair:ms", ms);
  await store.hincr("i:repair:verdicts", verdict);
  await store.hincr(`i:repair:by_program:${verdict}`, program);
  if (detail) await store.zincr(`i:repair:detail:${verdict}`, detail);
  await store.setStr("i:repair:last", JSON.stringify({ at: new Date().toISOString(), program, verdict, detail, ms }));
}

async function readIndex(store: Store) {
  const seen = await store.get("i:seen");
  const failed = await store.get("i:failed");
  const seenBy = await store.hgetall("i:seen_by_program");
  const failedBy = await store.hgetall("i:failed_by_program");
  return {
    updatedAt: await store.getStr("i:updated"),
    since: await store.getStr("i:since"),
    transactionsSeen: seen,
    failed,
    failureRate: seen ? failed / seen : 0,
    classified: await store.get("i:classified"),
    source: await store.hgetall("i:source"),
    byProgram: Object.keys(seenBy).map((p) => ({ program: p, seen: seenBy[p], failed: failedBy[p] ?? 0, failureRate: seenBy[p] ? (failedBy[p] ?? 0) / seenBy[p] : 0 })).sort((a, b) => b.failed - a.failed),
    topCauses: (await store.ztop("i:causes", 12)).map((r) => ({ title: r.member, count: r.score })),
    topCulprits: (await store.ztop("i:culprits", 10)).map((r) => ({ program: r.member, count: r.score })),
    repair: await readRepairStats(store),
  };
}

/** Our own hit rate on real failures: how many of the sampled landed failures the engine rebuilt, and why the rest could not be. */
async function readRepairStats(store: Store) {
  const attempted = await store.get("i:repair:attempted");
  const verdicts = await store.hgetall("i:repair:verdicts");
  const last = await store.getStr("i:repair:last");
  const byProgram = async (v: string) => store.hgetall(`i:repair:by_program:${v}`);
  return {
    attempted,
    verdicts,
    repairedRate: attempted ? (verdicts.repaired ?? 0) / attempted : 0,
    averageMs: attempted ? Math.round((await store.get("i:repair:ms")) / attempted) : 0,
    repairedByProgram: await byProgram("repaired"),
    unrepairable: (await store.ztop("i:repair:detail:not_repairable", 12)).map((r) => ({ title: r.member, count: r.score })),
    movedTooFar: (await store.ztop("i:repair:detail:moved_too_far", 6)).map((r) => ({ title: r.member, count: r.score })),
    engineErrors: (await store.ztop("i:repair:detail:engine_error", 6)).map((r) => ({ title: r.member, count: r.score })),
    last: last ? JSON.parse(last) : null,
  };
}

// ---------------------------------------------------------------- http

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 16_384) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function main() {
  const store = process.env.REDIS_URL ? await redisStore(process.env.REDIS_URL) : memoryStore();
  console.log(`storage: ${process.env.REDIS_URL ? "redis" : "memory"} | rpc: ${new URL(RPC_URL).host}`);
  if (!(await store.getStr("i:since"))) await store.setStr("i:since", new Date().toISOString());

  createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && path === "/stats") return json(res, 200, await readStats(store));
      if (req.method === "GET" && path === "/index") return json(res, 200, await readIndex(store));
      if (req.method === "POST" && path === "/admin/reset-usage") {
        if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized" });
        return json(res, 200, { cleared: await store.clear("s:") });
      }
      if (req.method === "POST" && path === "/limit") {
        // Global rate limit shared by every serverless instance. Callers are hashed, never stored raw.
        if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized" });
        const { caller, bucket, limit } = (await readBody(req)) as { caller?: string; bucket?: string; limit?: number };
        if (!caller || !bucket || !limit) return json(res, 400, { error: "caller, bucket and limit are required" });
        const minute = Math.floor(Date.now() / 60_000);
        const who = createHash("sha256").update(`${SALT}:${caller}`).digest("hex").slice(0, 24);
        const count = await store.hit(`rl:${String(bucket).slice(0, 20)}:${who}:${minute}`, 90);
        return json(res, 200, { ok: count <= limit, count, retryAfterSeconds: 60 - (Math.floor(Date.now() / 1000) % 60) });
      }
      if (req.method === "POST" && path === "/track") {
        if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized" });
        await track(store, (await readBody(req)) as TrackEvent);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 400, { error: e instanceof Error ? e.message : "bad request" });
    }
  }).listen(PORT, () => console.log(`txwhy worker listening on :${PORT}`));

  if (process.env.INDEX_DISABLED !== "1") {
    const loop = async () => {
      try {
        await sampleOnce(store);
      } catch (e) {
        console.error("index:", e instanceof Error ? e.message : e);
      }
      setTimeout(loop, POLL_MS);
    };
    void loop();
  }
}

void main();
