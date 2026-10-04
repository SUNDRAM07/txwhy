"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface IndexSummary {
  transactionsSeen: number;
  failureRate: number;
  byProgram: unknown[];
  repair?: { attempted: number; verdicts: Record<string, number>; segments?: { rebuilt: number; rebuiltShareOfPeople: number } };
}

const compact = (v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v.toLocaleString("en-US"));

/**
 * The live numbers behind the claim, read from the public index. The space is reserved so the page
 * does not jump when they arrive, and the strip stays empty if the index is unreachable.
 */
export function LiveProof() {
  const [index, setIndex] = useState<IndexSummary | null>(null);

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
  const stats: [string, string][] = index
    ? [
        [compact(index.transactionsSeen), `mainnet transactions sampled on ${index.byProgram.length} programs`],
        [`${Math.round(index.failureRate * 100)}%`, "of them failed"],
        [rebuilt.toLocaleString("en-US"), "real failures rebuilt and verified"],
        [`${index.repair?.verdicts.engine_error ?? 0}`, `engine errors in ${compact(index.repair?.attempted ?? 0)} attempts`],
      ]
    : [];

  return (
    <div className="mx-auto mt-8 min-h-[92px] max-w-2xl" aria-live="polite">
      {index && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {stats.map(([value, label]) => (
              <div key={label} className="rounded-xl border border-neutral-200 px-3 py-2 text-left dark:border-neutral-800">
                <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                <dt className="text-[11px] leading-tight text-neutral-500">{label}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-neutral-500">
            Measured live, updated every 90 seconds.{" "}
            <Link href="/failures" className="text-emerald-600 hover:underline dark:text-emerald-400">
              See why Solana transactions fail →
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
