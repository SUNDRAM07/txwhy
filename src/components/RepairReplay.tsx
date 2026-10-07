"use client";

/* ─────────────────────────────────────────────────────────
 * REPAIR REPLAY STORYBOARD (hero, right of the headline)
 *
 * The input and the Diagnose button are static and usable at
 * 0 ms. Only this panel cascades. Two modes:
 *
 * Recorded (autoplays once): one real repair from Oct 7, 2026.
 *    0 ms   frame visible, empty terminal, prompt blinking
 *  300 ms   command line appears
 *  900 ms   cause (0x1771)
 * 1500 ms   rebuild line: the minimum moved, nothing else
 * 2100 ms   simulation passed
 * 2600 ms   verification: 3 instructions kept byte for byte
 * 3100 ms   REPAIRED badge pops, link to the real transaction
 *
 * Live ("run one now"): builds a real failing swap on mainnet
 * state through the public API, repairs it, and renders the real
 * answer with the same cadence (120 ms per line).
 *
 * Reduced motion: finished states are shown at once.
 * ───────────────────────────────────────────────────────── */

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

const TIMING = { command: 300, diagnose: 900, rebuild: 1500, simulate: 2100, verify: 2600, verdict: 3100 } as const;
const LINE = { type: "spring" as const, stiffness: 350, damping: 28 };
const BADGE = { type: "spring" as const, stiffness: 280, damping: 22 };
const LIVE_STAGGER = 0.12;

/** A real landed failure, repaired by the live service. Values as returned on Oct 7, 2026. */
const REAL = {
  signature: "2PFypjb1KcZDXvmysUdUQUgofL1iRE74F1nUfARhcLS9nijQWMkJWhdp7CZKnhqD2RBoMjATYoGa3ZHXaai8hhUz",
  short: "2PFypjb1…ai8hhUz",
};

const dim = "text-neutral-500";
const up = "text-emerald-700 dark:text-emerald-400";
const down = "text-red-600 line-through decoration-red-500/60 dark:text-red-400";

const RECORDED: { at: number; stage: number; node: React.ReactNode }[] = [
  { at: TIMING.command, stage: 1, node: <p><span className={dim}>$</span> npx txwhy {REAL.short}</p> },
  { at: TIMING.diagnose, stage: 2, node: <p><span className={dim}>cause</span> SlippageToleranceExceeded <span className={dim}>0x1771</span> · price moved past a 2.53% tolerance</p> },
  { at: TIMING.rebuild, stage: 3, node: <p><span className={dim}>rebuild</span> swap re-quoted · receive at least <span className={down}>478.51</span> <span className={up}>677.68</span> 7CTR</p> },
  { at: TIMING.simulate, stage: 4, node: <p><span className={dim}>simulate</span> passed · 133,939 compute units</p> },
  { at: TIMING.verify, stage: 5, node: <p><span className={dim}>verify</span> 3 instructions kept byte for byte · nothing else was touched</p> },
];

interface RepairResponse {
  status: string;
  summary: string;
  cause: { title: string; code?: string } | null;
  changes: { type: string; before: string; after: string }[];
  simulation?: { passed: boolean; unitsConsumed: number | null };
  verification?: { ok: boolean; kept: number };
  repairedTransaction?: string | null;
}

type Live =
  | { state: "idle" }
  | { state: "building" }
  | { state: "repairing"; description: string }
  | { state: "done"; description: string; result: RepairResponse; ms: number }
  | { state: "error"; message: string };

const trim = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The real answer, in the same five-line shape as the recording. */
function liveLines(description: string, r: RepairResponse): React.ReactNode[] {
  const lines: React.ReactNode[] = [
    <p key="cmd"><span className={dim}>$</span> POST /api/v1/repair <span className={dim}>· {description}</span></p>,
  ];
  if (r.cause) lines.push(<p key="cause"><span className={dim}>cause</span> {r.cause.title}{r.cause.code ? <span className={dim}> {r.cause.code.split(" ")[0]}</span> : null}</p>);
  const swap = r.changes.find((c) => c.type === "swap_quote");
  const budget = r.changes.find((c) => c.type === "compute_unit_limit");
  if (swap) lines.push(<p key="swap"><span className={dim}>rebuild</span> swap re-quoted · <span className={down}>{trim(swap.before.replace(/\(quoted.*\)/, ""))}</span> <span className={up}>{trim(swap.after.replace(/\(.*\)/, ""))}</span></p>);
  else if (budget) lines.push(<p key="budget"><span className={dim}>rebuild</span> compute limit <span className={down}>{budget.before}</span> <span className={up}>{budget.after}</span></p>);
  else if (r.changes[0]) lines.push(<p key="chg"><span className={dim}>rebuild</span> {r.changes[0].type.replace(/_/g, " ")} · {trim(r.changes[0].after, 48)}</p>);
  if (r.simulation) lines.push(<p key="sim"><span className={dim}>simulate</span> {r.simulation.passed ? "passed" : "failed"}{r.simulation.unitsConsumed ? ` · ${r.simulation.unitsConsumed.toLocaleString("en-US")} compute units` : ""}</p>);
  if (r.verification) lines.push(<p key="ver"><span className={dim}>verify</span> {r.verification.ok ? `${r.verification.kept} instruction${r.verification.kept === 1 ? "" : "s"} kept byte for byte · nothing else was touched` : "refused"}</p>);
  return lines;
}

export function RepairReplay() {
  const reduced = useReducedMotion();
  const [played, setPlayed] = useState(0);
  const [run, setRun] = useState(0);
  const [live, setLive] = useState<Live>({ state: "idle" });
  const finalStage = 6;

  useEffect(() => {
    if (reduced) return;
    const timers = [
      ...RECORDED.map((s) => setTimeout(() => setPlayed((n) => Math.max(n, s.stage)), s.at)),
      setTimeout(() => setPlayed(finalStage), TIMING.verdict),
    ];
    return () => timers.forEach(clearTimeout);
  }, [reduced, run]);

  const stage = reduced ? finalStage : played;
  const recordedDone = stage >= finalStage;
  const showingLive = live.state !== "idle";

  function replay() {
    setLive({ state: "idle" });
    setPlayed(0);
    setRun((n) => n + 1);
  }

  async function runLive() {
    setLive({ state: "building" });
    const started = performance.now();
    try {
      const ex = await fetch("/api/v1/example?kind=slippage", { headers: { "x-txwhy-client": "web" } });
      const example = (await ex.json()) as { transaction?: string; description?: string; error?: string };
      if (!ex.ok || !example.transaction) throw new Error(example.error ?? (ex.status === 429 ? "Too many live runs from this network right now. Try again in a minute." : "Could not build a failing swap right now."));
      setLive({ state: "repairing", description: example.description ?? "a swap on a stale quote" });
      const res = await fetch("/api/v1/repair", { method: "POST", headers: { "content-type": "application/json", "x-txwhy-client": "web" }, body: JSON.stringify({ transaction: example.transaction }) });
      const result = (await res.json()) as RepairResponse & { error?: string };
      if (!res.ok || result.error) throw new Error(result.error ?? (res.status === 429 ? "Too many live runs from this network right now. Try again in a minute." : "The repair service did not answer."));
      setLive({ state: "done", description: example.description ?? "a swap on a stale quote", result, ms: Math.round(performance.now() - started) });
    } catch (e) {
      setLive({ state: "error", message: e instanceof Error ? e.message : "Something went wrong." });
    }
  }

  const liveDone = live.state === "done";
  const liveStatus = liveDone ? live.result.status : null;
  const badgeTone = liveStatus === "repaired" || liveStatus === "valid" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : liveStatus === "needs_requote" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-red-500/15 text-red-700 dark:text-red-400";
  const badgeText = liveStatus === "repaired" ? "REPAIRED · unsigned, yours to sign" : liveStatus === "valid" ? "VALID AS BUILT" : liveStatus === "needs_requote" ? "NO REPAIR: QUOTE STALE" : "NO REPAIR";

  return (
    <div
      className="relative rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-left font-mono text-[13px] leading-relaxed shadow-sm dark:border-neutral-800 dark:bg-neutral-900/70"
      aria-label={showingLive ? "A live repair on mainnet state" : "A real repair, replayed"}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
        <p className="text-[11px] text-neutral-500">
          {showingLive ? "live, on mainnet state right now" : "a real failure from mainnet, repaired live"}
        </p>
      </div>

      <div className="mt-3 min-h-[9.5rem] space-y-1.5" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          {!showingLive ? (
            <motion.div key={`recorded-${run}`} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: 0.12 }} className="space-y-1.5">
              {RECORDED.map((s) => (
                <motion.div
                  key={s.stage}
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: stage >= s.stage ? 1 : 0, y: stage >= s.stage ? 0 : 6 }}
                  transition={LINE}
                  aria-hidden={stage < s.stage}
                >
                  {s.node}
                </motion.div>
              ))}
              {!recordedDone && !reduced && <span className="inline-block h-4 w-2 animate-pulse bg-emerald-500/80 align-middle" aria-hidden />}
            </motion.div>
          ) : (
            <motion.div key="live" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }} className="space-y-1.5">
              {live.state === "building" && <p><span className={dim}>$</span> building a swap on a stale quote against live chain state<span className="animate-pulse">…</span></p>}
              {live.state === "repairing" && (
                <>
                  <p><span className={dim}>$</span> POST /api/v1/repair <span className={dim}>· {live.description}</span></p>
                  <p><span className={dim}>diagnose</span> simulating, classifying, rebuilding<span className="animate-pulse">…</span></p>
                </>
              )}
              {live.state === "error" && (
                <>
                  <p className="text-red-600 dark:text-red-400">{live.message}</p>
                  <button type="button" onClick={runLive} className="rounded text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:text-emerald-400">
                    try again
                  </button>
                </>
              )}
              {liveDone &&
                liveLines(live.description, live.result).map((node, i) => (
                  <motion.div key={i} initial={reduced ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ ...LINE, delay: reduced ? 0 : i * LIVE_STAGGER }}>
                    {node}
                  </motion.div>
                ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-3 flex min-h-[2.25rem] flex-wrap items-center justify-between gap-2">
        {!showingLive ? (
          <motion.span
            initial={reduced ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: recordedDone ? 1 : 0, scale: recordedDone ? 1 : 0.9 }}
            transition={BADGE}
            className="rounded-md bg-emerald-500/15 px-2 py-1 text-xs font-bold tracking-wide text-emerald-700 dark:text-emerald-400"
            aria-hidden={!recordedDone}
          >
            REPAIRED · unsigned, yours to sign
          </motion.span>
        ) : liveDone ? (
          <motion.span initial={reduced ? false : { opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ ...BADGE, delay: reduced ? 0 : LIVE_STAGGER * 5 }} className={`rounded-md px-2 py-1 text-xs font-bold tracking-wide ${badgeTone}`}>
            {badgeText} <span className="font-normal opacity-70">· {(live.ms / 1000).toFixed(1)} s</span>
          </motion.span>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-3 text-[11px]">
          {!showingLive && recordedDone && (
            <a href={`https://solscan.io/tx/${REAL.signature}`} target="_blank" rel="noreferrer" className="rounded text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:text-emerald-400">
              open the original failure →
            </a>
          )}
          {showingLive && (
            <button type="button" onClick={replay} className="rounded px-1 text-neutral-500 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:hover:text-neutral-100">
              back to the recording
            </button>
          )}
          <button
            type="button"
            onClick={runLive}
            disabled={live.state === "building" || live.state === "repairing"}
            aria-busy={live.state === "building" || live.state === "repairing"}
            className="min-h-8 rounded-md border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 transition-[background-color,transform] duration-100 hover:bg-emerald-500/20 active:translate-y-px focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none disabled:opacity-50 dark:text-emerald-400"
          >
            {live.state === "building" || live.state === "repairing" ? "running…" : "run one live now"}
          </button>
        </div>
      </div>
    </div>
  );
}
