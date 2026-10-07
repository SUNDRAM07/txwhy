"use client";

/* ─────────────────────────────────────────────────────────
 * LIVE PROOF STRIP
 *
 * Four numbers from the public index. Space is reserved so the
 * page does not jump; the strip stays empty if the index is down.
 * On first paint each number counts up over 600 ms, staggered
 * 80 ms apart. Reduced motion: final values at once.
 * ───────────────────────────────────────────────────────── */

import Link from "next/link";
import { useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

interface IndexSummary {
  transactionsSeen: number;
  failureRate: number;
  byProgram: unknown[];
  repair?: { attempted: number; verdicts: Record<string, number>; segments?: { rebuilt: number; rebuiltShareOfPeople: number } };
}

const COUNT_MS = 600;
const STAGGER_MS = 80;
const easeOutExpo = (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

/** Counts from 0 to `value` once, then holds. */
function useCountUp(value: number, delay: number, instant: boolean) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (instant) return;
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / COUNT_MS));
      setShown(value * easeOutExpo(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, delay, instant]);
  return instant ? value : shown;
}

function Stat({ value, format, label, delay, instant }: { value: number; format: (v: number) => string; label: string; delay: number; instant: boolean }) {
  const shown = useCountUp(value, delay, instant);
  return (
    <div className="rounded-xl border border-neutral-200 px-3 py-2 text-left dark:border-neutral-800">
      <dd className="text-lg font-semibold tabular-nums">{format(shown)}</dd>
      <dt className="text-[11px] leading-tight text-neutral-600 dark:text-neutral-400">{label}</dt>
    </div>
  );
}

const compact = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : Math.round(v).toLocaleString("en-US"));

export function LiveProof() {
  const [index, setIndex] = useState<IndexSummary | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    let alive = true;
    fetch("/api/v1/index", { headers: { "x-txwhy-client": "web" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: IndexSummary | null) => {
        if (alive && json?.transactionsSeen) setIndex(json);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const rebuilt = index?.repair?.segments?.rebuilt ?? index?.repair?.verdicts.repaired ?? 0;
  const instant = reduced === true;

  return (
    <div className="mx-auto mt-10 min-h-[92px] max-w-2xl" aria-live="polite">
      {index && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat value={index.transactionsSeen} format={compact} label={`mainnet transactions sampled on ${index.byProgram.length} programs`} delay={0} instant={instant} />
            <Stat value={index.failureRate * 100} format={(v) => `${Math.round(v)}%`} label="of them failed" delay={STAGGER_MS} instant={instant} />
            <Stat value={rebuilt} format={(v) => Math.round(v).toLocaleString("en-US")} label="real failures rebuilt and verified" delay={STAGGER_MS * 2} instant={instant} />
            <Stat value={index.repair?.verdicts.engine_error ?? 0} format={(v) => String(Math.round(v))} label={`engine errors in ${compact(index.repair?.attempted ?? 0)} attempts`} delay={STAGGER_MS * 3} instant={instant} />
          </dl>
          <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
            Measured live, updated every 90 seconds.{" "}
            <Link href="/failures" className="rounded text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:text-emerald-400">
              See why Solana transactions fail →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
