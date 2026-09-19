"use client";

import { useCallback, useState } from "react";
import type { RepairResult } from "@/lib/repair";

const STATUS: Record<RepairResult["status"], { label: string; tone: string }> = {
  repaired: { label: "Repaired", tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  valid: { label: "Already valid", tone: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  needs_requote: { label: "Needs a fresh quote", tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  not_repairable: { label: "Not repairable", tone: "bg-red-500/15 text-red-600 dark:text-red-400" },
};

const CHANGE_LABEL: Record<string, string> = {
  blockhash: "Blockhash",
  compute_unit_limit: "Compute unit limit",
  priority_fee: "Priority fee",
};

function short(v: string) {
  return v.length > 28 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}

export interface RepairInput {
  signature?: string;
  transaction?: string;
}

/** State + trigger for a repair call. The caller decides when to run (a click or a form submit). */
export function useRepair() {
  const [result, setResult] = useState<RepairResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async (input: RepairInput) => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/v1/repair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "Repair failed.");
      else setResult(body as RepairResult);
    } catch {
      setError("Could not reach the repair service.");
    } finally {
      setLoading(false);
    }
  }, []);

  return { result, error, loading, run };
}

/** Self-contained panel with its own button. Used on the transaction page. */
export function RepairPanel({ signature }: { signature: string }) {
  const state = useRepair();
  return <RepairView {...state} onRun={() => state.run({ signature })} />;
}

export function RepairView({
  result,
  error,
  loading,
  onRun,
}: {
  result: RepairResult | null;
  error: string | null;
  loading: boolean;
  onRun?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!result?.repairedTransaction) return;
    await navigator.clipboard.writeText(result.repairedTransaction);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="mt-6 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Repair</h2>
        {result && (
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${STATUS[result.status].tone}`}>
            {STATUS[result.status].label}
          </span>
        )}
        {!loading && onRun && (
          <button
            onClick={onRun}
            className="ml-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
          >
            {result || error ? "Run again" : "Try to repair"}
          </button>
        )}
      </div>

      {loading && (
        <p className="mt-4 text-sm text-neutral-500">
          Rebuilding and simulating against live chain state…
        </p>
      )}
      {error && <p className="mt-4 text-sm text-red-500">{error}</p>}

      {result && (
        <div className="mt-4 space-y-4 text-sm">
          <p className="leading-relaxed">{result.summary}</p>

          {result.cause && (
            <div className="rounded-lg bg-neutral-100 p-3 dark:bg-neutral-900">
              <p className="font-semibold">
                {result.cause.title}
                {result.cause.code && (
                  <span className="ml-2 font-mono text-xs font-normal text-neutral-500">
                    {result.cause.code}
                  </span>
                )}
              </p>
              {result.cause.cause && (
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">{result.cause.cause}</p>
              )}
            </div>
          )}

          {result.changes.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-xs uppercase tracking-wide text-neutral-500">
                  <tr>
                    <th className="py-1 pr-4 font-semibold">Change</th>
                    <th className="py-1 pr-4 font-semibold">Before</th>
                    <th className="py-1 font-semibold">After</th>
                  </tr>
                </thead>
                <tbody>
                  {result.changes.map((c) => (
                    <tr
                      key={c.type}
                      className="border-t border-neutral-200 align-top dark:border-neutral-800"
                    >
                      <td className="py-2 pr-4 font-medium">
                        {CHANGE_LABEL[c.type] ?? c.type}
                        <p className="mt-0.5 text-xs font-normal text-neutral-500">{c.reason}</p>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-red-600 dark:text-red-400">
                        {short(c.before)}
                      </td>
                      <td className="py-2 font-mono text-xs text-emerald-600 dark:text-emerald-400">
                        {short(c.after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-neutral-500">
            Simulation of the returned transaction:{" "}
            <span
              className={
                result.simulation.passed
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
              }
            >
              {result.simulation.passed ? "passed" : "failed"}
            </span>
            {result.simulation.unitsConsumed != null &&
              ` · ${result.simulation.unitsConsumed.toLocaleString()} compute units`}
          </p>

          {result.repairedTransaction && (
            <div>
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Rebuilt transaction · unsigned · base64
                </p>
                <button
                  onClick={copy}
                  className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="mt-1 max-h-28 overflow-auto rounded-lg border border-neutral-200 p-3 font-mono text-xs break-all whitespace-pre-wrap dark:border-neutral-800">
                {result.repairedTransaction}
              </pre>
              <p className="mt-1 text-xs text-neutral-500">
                Sign it with your own wallet and send it. TxWhy never sees your keys.
              </p>
            </div>
          )}

          {result.notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-neutral-500">
              {result.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
