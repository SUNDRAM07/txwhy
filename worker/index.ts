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
/** Wallet watcher: how often watched addresses are polled, and where failure alerts are sent (the site relays them to Telegram). */
const WATCH_POLL_MS = Number(process.env.WATCH_POLL_MS ?? 30_000);
const SITE_URL = (process.env.SITE_URL ?? "https://txwhy.vercel.app").replace(/\/$/, "");
const WATCH_MAX_PER_CHAT = 3;
const WATCH_ALERTS_PER_HOUR = 5;

const WATCHED: Record<string, string> = {
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora DBC",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "Raydium LaunchLab",
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
  /** String-valued hashes, for the wallet watcher's small lists. */
  hset(key: string, field: string, value: string): Promise<void>;
  hdel(key: string, field: string): Promise<void>;
  hgetallStr(key: string): Promise<Record<string, string>>;
}

function memoryStore(): Store {
  const nums = new Map<string, number>();
  const hashes = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const strs = new Map<string, string>();
  const windows = new Map<string, { n: number; until: number }>();
  const h = (k: string) => hashes.get(k) ?? hashes.set(k, new Map()).get(k)!;
  const shashes = new Map<string, Map<string, string>>();
  const sh = (k: string) => shashes.get(k) ?? shashes.set(k, new Map()).get(k)!;
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
    async hset(k, f, v) { sh(k).set(f, v); },
    async hdel(k, f) { sh(k).delete(f); },
    async hgetallStr(k) { return Object.fromEntries(sh(k)); },
    async clear(prefix) {
      let n = 0;
      for (const m of [nums, hashes, sets, strs, shashes] as Map<string, unknown>[]) {
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
    async hset(k, f, v) { await client.hSet(k, f, v); },
    async hdel(k, f) { await client.hDel(k, f); },
    async hgetallStr(k) { return client.hGetAll(k); },
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

/**
 * One precise reason a landed failure was not rebuilt, read from the engine's own notes. The ranked
 * title list says WHAT failed; this says WHY the engine left it alone, which is what decides the next
 * thing to build and keeps the published numbers honest about bots and routers.
 */
export function whyNot(result: { status: string; summary: string; cause: { title: string } | null; notes: string[] }): string {
  const text = `${result.cause?.title ?? ""} ${result.summary} ${result.notes.join(" ")}`;
  if (/circular arbitrage/i.test(text)) return "arbitrage";
  if (/Lighthouse guard|safety guard set by the wallet/i.test(text)) return "wallet_guard";
  if (/chains \d+ direct swaps/.test(text)) return "chained_swaps";
  if (/completed its bonding curve/.test(text)) return "pool_graduated";
  if (/Launch pool nearly full|room left before it graduates|InsufficientLiquidity|SwapAmountIsOverAThreshold/.test(text)) return "pool_nearly_full";
  if (/moved more than \d+% against this trade/.test(text)) return "beyond_cap";
  if (/No swap found that TxWhy can re-quote|not a top-level instruction|inside another program by CPI/.test(text)) return "routed_by_private_program";
  if (/spliced in but the transaction still fails|lifted the transaction still fails|both raised \d+%/.test(text)) return "more_than_slippage";
  if (/fits its own limit/.test(text)) return "not_slippage_now";
  if (/Re-run today, this transaction fails earlier/.test(text)) return "state_changed_since";
  if (/from a private program/i.test(result.cause?.title ?? "")) return "private_program";
  if (/insufficient|holds .* lamports and needs|Shortfall/i.test(text)) return "no_funds";
  if (result.status === "needs_requote") return "needs_requote_other";
  return "other";
}

/** Runs one landed failure through the repair engine and records only the verdict. Nothing about the transaction is stored. */
async function attemptRepair(store: Store, program: string, signature: string) {
  const started = Date.now();
  let verdict: string;
  let detail: string | null = null;
  let why: string | null = null;
  try {
    const result = await repair({ signature });
    if (result.status === "repaired" && result.verification?.ok && result.simulation.passed) verdict = "repaired";
    else if (result.status === "repaired") verdict = "repaired_unverified";
    else if (result.status === "valid") verdict = "valid";
    else if (result.status === "needs_requote") verdict = "moved_too_far";
    else verdict = "not_repairable";
    if (verdict === "not_repairable" || verdict === "moved_too_far") {
      detail = reasonKey(result.cause?.title, result.summary);
      why = whyNot(result);
    } else if (verdict === "repaired") {
      why = result.changes.some((c) => c.type === "swap_quote") ? "rebuilt_swap" : "rebuilt_budget_or_blockhash";
    }
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
  if (why) {
    await store.hincr("i:repair:why", why);
    await store.hincr(`i:repair:why:${program}`, why);
  }
  await store.setStr("i:repair:last", JSON.stringify({ at: new Date().toISOString(), program, verdict, detail, ms }));
}

// ---------------------------------------------------------------- wallet watcher
//
// A Telegram user says /watch <address>; the bot registers it here. Every WATCH_POLL_MS the worker looks
// for new failed transactions from each watched address, runs the diagnosis, and asks the site to send the
// alert (the site holds the bot token; this process never does). Stored: the address, the chat id, a
// signature cursor. /unwatch deletes all of it.

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const isAddress = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

async function watchOp(store: Store, op: string, chatId: number, address?: string) {
  const chatKey = `w:chat:${chatId}`;
  if (op === "list") return { ok: true, addresses: Object.keys(await store.hgetallStr(chatKey)) };
  if (!address || !isAddress(address)) return { ok: false, error: "That is not a Solana address." };
  if (op === "remove") {
    await store.hdel(chatKey, address);
    await store.hdel(`w:addr:${address}`, String(chatId));
    if (Object.keys(await store.hgetallStr(`w:addr:${address}`)).length === 0) await store.hdel("w:list", address);
    return { ok: true, addresses: Object.keys(await store.hgetallStr(chatKey)) };
  }
  if (op === "add") {
    const mine = await store.hgetallStr(chatKey);
    if (!(address in mine) && Object.keys(mine).length >= WATCH_MAX_PER_CHAT) {
      return { ok: false, error: `You can watch up to ${WATCH_MAX_PER_CHAT} addresses. /unwatch one first.` };
    }
    // Start from now: only failures after the /watch are reported.
    if (!(await store.getStr(`w:cursor:${address}`))) {
      const latest = await rpc<SigInfo[]>("getSignaturesForAddress", [address, { limit: 1 }]);
      if (latest?.[0]) await store.setStr(`w:cursor:${address}`, latest[0].signature);
    }
    const now = new Date().toISOString();
    await store.hset(chatKey, address, now);
    await store.hset(`w:addr:${address}`, String(chatId), now);
    await store.hset("w:list", address, now);
    return { ok: true, addresses: Object.keys(await store.hgetallStr(chatKey)) };
  }
  return { ok: false, error: "unknown op" };
}

async function notify(chatId: number, html: string) {
  try {
    await fetch(`${SITE_URL}/api/telegram/notify`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ chatId, html }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error("notify:", e instanceof Error ? e.message : e);
  }
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function alertFor(address: string, signature: string): Promise<string> {
  const lines = [`🔴 <b>Transaction failed</b> from <code>${short(address)}</code>`];
  try {
    const result = await repair({ signature });
    if (result.cause) {
      lines.push(`<b>${escapeHtml(result.cause.title)}</b>: ${escapeHtml(result.cause.cause)}`);
      // The engine's verdict explains the situation (for example a circular arbitrage that only wins while the
      // opportunity exists); the generic "nothing to fix" line would only confuse a person reading an alert.
      if (result.status === "not_repairable" && result.summary) lines.push(escapeHtml(result.summary));
      else if (result.cause.fix) lines.push(`Fix: ${escapeHtml(result.cause.fix)}`);
    } else {
      lines.push(escapeHtml(result.summary));
    }
    if (result.status === "repaired") lines.push("✅ TxWhy rebuilt it and the rebuilt transaction passes simulation. Open the link to get it, unsigned.");
    else if (result.status === "needs_requote") lines.push("🟠 The price moved past your tolerance. Get a fresh quote and resend.");
  } catch (e) {
    lines.push(escapeHtml(e instanceof Error ? e.message : "Could not fetch the details."));
  }
  lines.push(`<a href="${SITE_URL}/tx/${signature}">Full breakdown on TxWhy</a>`);
  return lines.join("\n");
}

async function watchOnce(store: Store) {
  const addresses = Object.keys(await store.hgetallStr("w:list"));
  for (const address of addresses) {
    const cursor = await store.getStr(`w:cursor:${address}`);
    const sigs = await rpc<SigInfo[]>("getSignaturesForAddress", [address, { limit: 25, ...(cursor ? { until: cursor } : {}) }]);
    if (!sigs || sigs.length === 0) continue;
    await store.setStr(`w:cursor:${address}`, sigs[0].signature);
    const failed = sigs.filter((s) => s.err).reverse(); // oldest first
    if (failed.length === 0) continue;
    const chats = Object.keys(await store.hgetallStr(`w:addr:${address}`)).map(Number);
    if (chats.length === 0) continue;
    for (const s of failed) {
      const n = await store.hit(`w:cap:${address}`, 3600);
      if (n > WATCH_ALERTS_PER_HOUR) {
        if (n === WATCH_ALERTS_PER_HOUR + 1) {
          for (const c of chats) await notify(c, `<code>${short(address)}</code> is failing a lot (${WATCH_ALERTS_PER_HOUR}+ this hour). Muting alerts for it until the hour is over; /unwatch to stop entirely.`);
        }
        break;
      }
      const html = await alertFor(address, s.signature);
      for (const c of chats) await notify(c, html);
      await store.incr("w:alerts");
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Hourly snapshot of the cumulative counters, kept 30 days, so the index has a history and a downloadable dataset. */
const HISTORY_DAYS = 30;
let lastHistoryHour = "";
async function snapshotHistory(store: Store) {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  const seenBy = await store.hgetall("i:seen_by_program");
  const failedBy = await store.hgetall("i:failed_by_program");
  const verdicts = await store.hgetall("i:repair:verdicts");
  const point = {
    t: `${hour}:00:00.000Z`,
    seen: await store.get("i:seen"),
    failed: await store.get("i:failed"),
    attempted: await store.get("i:repair:attempted"),
    rebuilt: verdicts.repaired ?? 0,
    by: Object.fromEntries(Object.keys(seenBy).map((p) => [p, [seenBy[p], failedBy[p] ?? 0]])),
  };
  await store.hset("i:hist", hour, JSON.stringify(point));
  if (hour !== lastHistoryHour) {
    lastHistoryHour = hour;
    const cutoff = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 13);
    for (const key of Object.keys(await store.hgetallStr("i:hist"))) if (key < cutoff) await store.hdel("i:hist", key);
  }
}

export interface HistoryPoint {
  t: string;
  seen: number;
  failed: number;
  attempted: number;
  rebuilt: number;
  by?: Record<string, [number, number]>;
}

async function readHistory(store: Store, days: number, withPrograms: boolean): Promise<HistoryPoint[]> {
  const raw = await store.hgetallStr("i:hist");
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13);
  return Object.keys(raw)
    .filter((k) => k >= cutoff)
    .sort()
    .map((k) => {
      const point = JSON.parse(raw[k]) as HistoryPoint;
      if (!withPrograms) delete point.by;
      return point;
    });
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
    history: await readHistory(store, 7, false),
    watch: { addresses: Object.keys(await store.hgetallStr("w:list")).length, alerts: await store.get("w:alerts") },
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
    segments: await repairSegments(store, attempted, verdicts),
    /** Precise reasons, counted since this breakdown was added (Oct 4, 2026). */
    why: await store.hgetall("i:repair:why"),
    whyByProgram: Object.fromEntries(await Promise.all(Object.values(WATCHED).map(async (name) => [name, await store.hgetall(`i:repair:why:${name}`)] as const))),
  };
}

/**
 * The raw rebuilt rate is dominated by automated traders whose transactions were meant to fail when the
 * opportunity was gone (private programs, circular arbitrage). Splitting them out gives the number that
 * matters: of the failures a person or an app would care about, how many did we rebuild.
 */
async function repairSegments(store: Store, attempted: number, verdicts: Record<string, number>) {
  const sum = (rows: { member: string; score: number }[], re: RegExp) => rows.filter((r) => re.test(r.member)).reduce((n, r) => n + r.score, 0);
  const unfixable = await store.ztop("i:repair:detail:not_repairable", 2000);
  const moved = await store.ztop("i:repair:detail:moved_too_far", 2000);
  const BOT = /^Private program \(unnamed\)|circular arbitrage/;
  const GUARD = /^Lighthouse guard/;
  const bots = sum(unfixable, BOT) + sum(moved, BOT);
  const guards = sum(unfixable, GUARD) + sum(moved, GUARD);
  const rebuilt = verdicts.repaired ?? 0;
  const movedTooFar = Math.max(0, (verdicts.moved_too_far ?? 0) - sum(moved, BOT) - sum(moved, GUARD));
  const people = Math.max(0, attempted - bots);
  const deadEnds = Math.max(0, people - rebuilt - movedTooFar - guards - (verdicts.engine_error ?? 0) - (verdicts.valid ?? 0));
  return { bots, people, rebuilt, movedTooFar, guards, deadEnds, rebuiltShareOfPeople: people ? rebuilt / people : 0 };
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

// Event-loop lag: how late a 1 s timer fires. Large values mean something synchronous is hogging the thread.
let lag = 0;
let maxLag = 0;
{
  let expected = Date.now() + 1000;
  let laggy = 0;
  setInterval(() => {
    lag = Math.max(0, Date.now() - expected);
    maxLag = Math.max(maxLag, lag);
    expected = Date.now() + 1000;
    // Watchdog: all state lives in Redis, so a restart costs nothing, while a stalled process costs every alert and index pass.
    const rssMB = process.memoryUsage().rss / 1048576;
    laggy = lag > 3000 ? laggy + 1 : 0;
    if (Math.round(process.uptime()) % 600 === 0) console.log(`mem: rss ${Math.round(rssMB)} MB, heap ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB, max lag ${maxLag} ms, uptime ${Math.round(process.uptime() / 60)} min`);
    if (rssMB > 420 || laggy >= 5) {
      console.error(`watchdog: restarting (rss ${Math.round(rssMB)} MB, lag ${lag} ms, max lag ${maxLag} ms, uptime ${Math.round(process.uptime())} s)`);
      setTimeout(() => process.exit(1), 200);
    }
  }, 1000);
}

async function main() {
  const store = process.env.REDIS_URL ? await redisStore(process.env.REDIS_URL) : memoryStore();
  console.log(`storage: ${process.env.REDIS_URL ? "redis" : "memory"} | rpc: ${new URL(RPC_URL).host}`);
  if (!(await store.getStr("i:since"))) await store.setStr("i:since", new Date().toISOString());

  createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/health") {
        const m = process.memoryUsage();
        return json(res, 200, { ok: true, uptimeS: Math.round(process.uptime()), rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576), heapTotalMB: Math.round(m.heapTotal / 1048576), external: Math.round(m.external / 1048576), eventLoopLagMs: lag, maxLagMs: maxLag });
      }
      if (req.method === "GET" && path === "/stats") return json(res, 200, await readStats(store));
      if (req.method === "GET" && path === "/index") return json(res, 200, await readIndex(store));
      if (req.method === "GET" && path === "/history") {
        return json(res, 200, { since: await store.getStr("i:since"), days: HISTORY_DAYS, points: await readHistory(store, HISTORY_DAYS, true) });
      }
      if (req.method === "POST" && path === "/watch") {
        if (!SECRET || req.headers.authorization !== `Bearer ${SECRET}`) return json(res, 401, { error: "unauthorized" });
        const body = (await readBody(req)) as { op?: string; chatId?: number; address?: string };
        if (!body || typeof body.chatId !== "number" || !body.op) return json(res, 400, { error: "bad request" });
        return json(res, 200, await watchOp(store, body.op, body.chatId, body.address?.trim()));
      }
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
        await snapshotHistory(store);
      } catch (e) {
        console.error("index:", e instanceof Error ? e.message : e);
      }
      setTimeout(loop, POLL_MS);
    };
    void loop();
  }

  // Wallet watcher: independent cadence, so a slow index pass never delays an alert.
  const watchLoop = async () => {
    try {
      await watchOnce(store);
    } catch (e) {
      console.error("watch:", e instanceof Error ? e.message : e);
    }
    setTimeout(watchLoop, WATCH_POLL_MS);
  };
  void watchLoop();
}

void main();
