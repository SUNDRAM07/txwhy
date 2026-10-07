"use client";

/* ─────────────────────────────────────────────────────────
 * FAILURE BARS
 *
 * The nine programs the worker samples, ranked by failure rate,
 * from the public index. Bars grow from zero once, when the
 * block scrolls into view, 40 ms apart. Hover or focus a row to
 * see the counts. Reduced motion: bars at full width at once.
 * ───────────────────────────────────────────────────────── */

import Link from "next/link";
import { motion, useInView, useReducedMotion } from "framer-motion";
import { useRef } from "react";
import { compact } from "./LiveProof";
import { useIndex } from "./useIndex";

export function FailureBars() {
  const index = useIndex();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduced = useReducedMotion();
  const rows = [...(index?.byProgram ?? [])].sort((a, b) => b.failureRate - a.failureRate);

  return (
    <div ref={ref} className="min-h-[18rem]">
      {rows.length === 0 ? (
        <ul className="space-y-3" aria-hidden>
          {Array.from({ length: 9 }).map((_, i) => (
            <li key={i} className="h-7 animate-pulse rounded-md bg-neutral-100 dark:bg-neutral-900" />
          ))}
        </ul>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r, i) => {
            const pct = Math.round(r.failureRate * 100);
            return (
              <li key={r.program} className="group rounded-md focus-within:ring-2 focus-within:ring-emerald-500" tabIndex={0} aria-label={`${r.program}: ${pct}% of ${compact(r.seen)} sampled transactions failed`}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium">{r.program}</span>
                  <span className="tabular-nums text-neutral-600 dark:text-neutral-400">
                    <span className="hidden group-focus-within:inline group-hover:inline">{compact(r.failed)} of {compact(r.seen)} · </span>
                    <span className="font-semibold text-neutral-900 dark:text-neutral-100">{pct}%</span>
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <motion.div
                    className="h-2 rounded-full bg-emerald-500 group-hover:bg-emerald-400"
                    initial={reduced ? { width: `${pct}%` } : { width: 0 }}
                    animate={inView || reduced ? { width: `${pct}%` } : { width: 0 }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: reduced ? 0 : i * 0.04 }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-xs text-neutral-600 dark:text-neutral-400">
        Share of sampled transactions that failed, last pass. Most of the failures on the big exchanges are bots built to miss; the{" "}
        <Link href="/failures" className="rounded text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:text-emerald-400">
          failure index
        </Link>{" "}
        separates them and says exactly what happened to each one TxWhy tried.
      </p>
    </div>
  );
}
