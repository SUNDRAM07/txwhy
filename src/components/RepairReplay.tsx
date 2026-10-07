"use client";

/* ─────────────────────────────────────────────────────────
 * REPAIR REPLAY STORYBOARD (hero, right of the headline)
 *
 * The input and the Diagnose button are static and usable at
 * 0 ms. Only this panel cascades. It replays one real repair,
 * recorded from production on Oct 7, 2026, line by line.
 *
 *    0 ms   frame visible, empty terminal, prompt blinking
 *  300 ms   command line appears
 *  900 ms   "diagnosing" line + cause (0x1771)
 * 1500 ms   rebuild line: the minimum moved, nothing else
 * 2100 ms   simulation passed
 * 2600 ms   verification: 3 instructions kept byte for byte
 * 3100 ms   REPAIRED badge pops, link to the real transaction
 *
 * Reduced motion: the finished state is shown at once.
 * ───────────────────────────────────────────────────────── */

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

const TIMING = {
  command: 300,
  diagnose: 900,
  rebuild: 1500,
  simulate: 2100,
  verify: 2600,
  verdict: 3100,
} as const;

const LINE = { type: "spring" as const, stiffness: 350, damping: 28 };
const BADGE = { type: "spring" as const, stiffness: 280, damping: 22 };

/** A real landed failure, repaired by the live service. Values as returned on Oct 7, 2026. */
const REAL = {
  signature: "2PFypjb1KcZDXvmysUdUQUgofL1iRE74F1nUfARhcLS9nijQWMkJWhdp7CZKnhqD2RBoMjATYoGa3ZHXaai8hhUz",
  short: "2PFypjb1…ai8hhUz",
};

const STEPS: { at: number; stage: number; render: () => React.ReactNode }[] = [
  {
    at: TIMING.command,
    stage: 1,
    render: () => (
      <p>
        <span className="text-neutral-500">$</span> npx txwhy {REAL.short}
      </p>
    ),
  },
  {
    at: TIMING.diagnose,
    stage: 2,
    render: () => (
      <p>
        <span className="text-neutral-500">cause</span> SlippageToleranceExceeded{" "}
        <span className="text-neutral-500">0x1771</span> · price moved past a 2.53% tolerance
      </p>
    ),
  },
  {
    at: TIMING.rebuild,
    stage: 3,
    render: () => (
      <p>
        <span className="text-neutral-500">rebuild</span> swap re-quoted · receive at least{" "}
        <span className="text-red-500 line-through decoration-red-500/60">478.51</span>{" "}
        <span className="text-emerald-600 dark:text-emerald-400">677.68</span> 7CTR
      </p>
    ),
  },
  {
    at: TIMING.simulate,
    stage: 4,
    render: () => (
      <p>
        <span className="text-neutral-500">simulate</span> passed · 133,939 compute units
      </p>
    ),
  },
  {
    at: TIMING.verify,
    stage: 5,
    render: () => (
      <p>
        <span className="text-neutral-500">verify</span> 3 instructions kept byte for byte · nothing else was touched
      </p>
    ),
  },
];

export function RepairReplay() {
  const reduced = useReducedMotion();
  const [played, setPlayed] = useState(0);
  const [run, setRun] = useState(0);
  const finalStage = 6;

  useEffect(() => {
    if (reduced) return;
    const timers = [
      ...STEPS.map((s) => setTimeout(() => setPlayed((n) => Math.max(n, s.stage)), s.at)),
      setTimeout(() => setPlayed(finalStage), TIMING.verdict),
    ];
    return () => timers.forEach(clearTimeout);
  }, [reduced, run]);

  // Reduced motion shows the finished state at once; otherwise the stage is whatever the timers have reached.
  const stage = reduced ? finalStage : played;
  const done = stage >= finalStage;

  function replay() {
    setPlayed(0);
    setRun((n) => n + 1);
  }

  return (
    <div
      className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 text-left font-mono text-[13px] leading-relaxed shadow-sm dark:border-neutral-800 dark:bg-neutral-900/60"
      aria-label="A real repair, replayed"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
          <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
        <p className="text-[11px] text-neutral-500">a real failure from mainnet, repaired live</p>
      </div>

      <div className="mt-3 min-h-[9.5rem] space-y-1.5">
        {STEPS.map((s) => (
          <motion.div
            key={`${run}-${s.stage}`}
            initial={reduced ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: stage >= s.stage ? 1 : 0, y: stage >= s.stage ? 0 : 6 }}
            transition={LINE}
            aria-hidden={stage < s.stage}
          >
            {s.render()}
          </motion.div>
        ))}
        {!done && !reduced && (
          <span className="inline-block h-4 w-2 animate-pulse bg-emerald-500/80 align-middle" aria-hidden />
        )}
      </div>

      <div className="mt-3 flex min-h-[2.25rem] flex-wrap items-center justify-between gap-2">
        <motion.span
          initial={reduced ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: done ? 1 : 0, scale: done ? 1 : 0.9 }}
          transition={BADGE}
          className="rounded-md bg-emerald-500/15 px-2 py-1 text-xs font-bold tracking-wide text-emerald-700 dark:text-emerald-400"
          aria-hidden={!done}
        >
          REPAIRED · unsigned, yours to sign
        </motion.span>
        <div className="flex items-center gap-3 text-[11px]">
          {done && (
            <a
              href={`https://solscan.io/tx/${REAL.signature}`}
              target="_blank"
              rel="noreferrer"
              className="rounded text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:text-emerald-400"
            >
              open the original failure →
            </a>
          )}
          {!reduced && (
            <button
              type="button"
              onClick={replay}
              className="rounded px-1 text-neutral-500 hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:hover:text-neutral-100"
              aria-label="Replay the repair"
            >
              replay
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
