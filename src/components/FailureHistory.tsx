"use client";

import { useId, useMemo, useState } from "react";

export interface HistoryPoint {
  t: string;
  seen: number;
  failed: number;
}

interface Hour {
  t: Date;
  rate: number;
  seen: number;
  failed: number;
}

const W = 640;
const H = 180;
const PAD = { top: 12, right: 44, bottom: 24, left: 36 };
const MIN_SAMPLE = 200;

/** Per-hour failure rates from cumulative snapshots. Hours with a thin sample are skipped rather than shown as noise. */
function hours(points: HistoryPoint[]): Hour[] {
  const out: Hour[] = [];
  for (let i = 1; i < points.length; i++) {
    const seen = points[i].seen - points[i - 1].seen;
    const failed = points[i].failed - points[i - 1].failed;
    if (seen < MIN_SAMPLE || failed < 0) continue;
    out.push({ t: new Date(points[i].t), rate: failed / seen, seen, failed });
  }
  return out;
}

const fmtHour = (d: Date) => `${d.toUTCString().slice(5, 16)} ${String(d.getUTCHours()).padStart(2, "0")}:00 UTC`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/**
 * One series, one axis: the share of sampled transactions that failed, per hour. A line with a
 * crosshair tooltip; the latest value is the only direct label. The table under it is the same data.
 */
export function FailureHistory({ points }: { points: HistoryPoint[] }) {
  const rows = useMemo(() => hours(points), [points]);
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();

  if (rows.length < 3) {
    return (
      <p className="mt-2 text-xs text-neutral-500">
        Hourly history is being collected (snapshots began Oct 8, 2026); the chart appears after three full hours. The dataset is already live at{" "}
        <a href="/api/v1/index/history" className="underline decoration-neutral-300 underline-offset-2 hover:text-emerald-600 dark:decoration-neutral-700 dark:hover:text-emerald-400">
          /api/v1/index/history
        </a>
        .
      </p>
    );
  }

  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const t0 = rows[0].t.getTime();
  const t1 = rows[rows.length - 1].t.getTime();
  const rates = rows.map((r) => r.rate);
  const lo = Math.max(0, Math.floor((Math.min(...rates) - 0.03) * 20) / 20);
  const hi = Math.min(1, Math.ceil((Math.max(...rates) + 0.03) * 20) / 20);
  const x = (t: Date) => PAD.left + (t1 === t0 ? innerW / 2 : ((t.getTime() - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const path = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(r.t).toFixed(1)},${y(r.rate).toFixed(1)}`).join(" ");
  const ticks = [lo, (lo + hi) / 2, hi];
  const last = rows[rows.length - 1];
  const dayMarks = rows.filter((r, i) => i === 0 || r.t.getUTCDate() !== rows[i - 1].t.getUTCDate());

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    for (let i = 1; i < rows.length; i++) if (Math.abs(x(rows[i].t) - px) < Math.abs(x(rows[best].t) - px)) best = i;
    setHover(best);
  }

  const h = hover == null ? null : rows[hover];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-3 w-full"
        role="img"
        aria-labelledby={`${id}-title`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <title id={`${id}-title`}>Share of sampled transactions that failed, per hour, latest {pct(last.rate)}</title>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-neutral-200 dark:stroke-neutral-800" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v) + 3} textAnchor="end" className="fill-neutral-500" fontSize={10}>
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        {dayMarks.map((r) => (
          <text key={r.t.toISOString()} x={x(r.t)} y={H - 6} textAnchor="middle" className="fill-neutral-500" fontSize={10}>
            {r.t.toUTCString().slice(5, 11)}
          </text>
        ))}
        <path d={path} fill="none" className="stroke-emerald-500" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <text x={x(last.t) + 6} y={y(last.rate) + 3} className="fill-neutral-700 dark:fill-neutral-300" fontSize={11} fontWeight={600}>
          {pct(last.rate)}
        </text>
        {h && (
          <g>
            <line x1={x(h.t)} x2={x(h.t)} y1={PAD.top} y2={H - PAD.bottom} className="stroke-neutral-400 dark:stroke-neutral-600" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(h.t)} cy={y(h.rate)} r={4} className="fill-emerald-500 stroke-white dark:stroke-neutral-950" strokeWidth={2} />
          </g>
        )}
      </svg>
      <p className="mt-1 min-h-5 text-xs text-neutral-500 tabular-nums" aria-live="polite">
        {h ? `${fmtHour(h.t)}: ${pct(h.rate)} failed (${h.failed.toLocaleString("en-US")} of ${h.seen.toLocaleString("en-US")} sampled)` : `Hover for any hour. Latest: ${fmtHour(last.t)}, ${pct(last.rate)} of ${last.seen.toLocaleString("en-US")} sampled.`}
      </p>
      <details className="mt-2 text-xs text-neutral-500">
        <summary className="cursor-pointer hover:text-emerald-600 dark:hover:text-emerald-400">Table view and dataset</summary>
        <table className="mt-2 w-full text-left tabular-nums">
          <thead>
            <tr className="text-neutral-500">
              <th className="py-1 font-medium">Hour (UTC)</th>
              <th className="py-1 font-medium">Sampled</th>
              <th className="py-1 font-medium">Failed</th>
              <th className="py-1 font-medium">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice()
              .reverse()
              .slice(0, 48)
              .map((r) => (
                <tr key={r.t.toISOString()} className="border-t border-neutral-100 dark:border-neutral-900">
                  <td className="py-1">{fmtHour(r.t)}</td>
                  <td className="py-1">{r.seen.toLocaleString("en-US")}</td>
                  <td className="py-1">{r.failed.toLocaleString("en-US")}</td>
                  <td className="py-1">{pct(r.rate)}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <p className="mt-2">
          Full 30-day dataset, hourly, per program, CC BY 4.0:{" "}
          <a href="/api/v1/index/history" className="underline decoration-neutral-300 underline-offset-2 hover:text-emerald-600 dark:decoration-neutral-700 dark:hover:text-emerald-400">
            /api/v1/index/history
          </a>
        </p>
      </details>
    </div>
  );
}
