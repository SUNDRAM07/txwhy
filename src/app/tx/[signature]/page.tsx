import Link from "next/link";
import { getTrace } from "@/lib/trace";
import type { TraceNode } from "@/lib/types";

export const dynamic = "force-dynamic";

function Node({ node }: { node: TraceNode }) {
  return (
    <li>
      <div
        className={`flex items-baseline gap-2 rounded-md px-2 py-1.5 font-mono text-sm ${
          node.failed
            ? "bg-red-500/10 text-red-600 ring-1 ring-red-500/40 dark:text-red-400"
            : ""
        }`}
      >
        <span className="text-neutral-400 dark:text-neutral-500">#{node.index}</span>
        <span className="font-semibold">{node.programName}</span>
        {node.instructionName && (
          <span className="text-neutral-500 dark:text-neutral-400">
            {node.instructionName}
          </span>
        )}
        {node.failed && (
          <span className="ml-auto shrink-0 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-semibold uppercase">
            failed
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-5 border-l border-neutral-200 pl-3 dark:border-neutral-800">
          {node.children.map((c) => (
            <Node key={c.index} node={c} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function TxPage({
  params,
}: {
  params: Promise<{ signature: string }>;
}) {
  const { signature } = await params;

  let trace = null;
  let fetchError: string | null = null;
  try {
    trace = await getTrace(signature);
  } catch (e) {
    fetchError = e instanceof Error ? e.message : "Unknown RPC error";
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/" className="font-bold tracking-tight">
        Tx<span className="text-emerald-500">Why</span>
      </Link>

      <p className="mt-4 break-all font-mono text-xs text-neutral-400 dark:text-neutral-500">
        {signature}
      </p>

      {fetchError && (
        <div className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          RPC error: {fetchError}. Try again in a moment — public RPC rate limits are tight.
        </div>
      )}

      {!fetchError && !trace && (
        <div className="mt-6 rounded-lg border border-neutral-300 p-4 text-sm dark:border-neutral-700">
          Transaction not found. It may be older than the RPC&apos;s history, on a different
          cluster, or the signature is wrong.
        </div>
      )}

      {trace && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
            <span
              className={`rounded-full px-3 py-1 font-semibold ${
                trace.success
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "bg-red-500/15 text-red-600 dark:text-red-400"
              }`}
            >
              {trace.success ? "Success" : "Failed"}
            </span>
            <span className="text-neutral-500">Slot {trace.slot.toLocaleString()}</span>
            {trace.blockTime && (
              <span className="text-neutral-500">
                {new Date(trace.blockTime * 1000).toUTCString()}
              </span>
            )}
            <span className="text-neutral-500">
              Fee {(trace.feeLamports / 1e9).toFixed(6)} SOL
            </span>
          </div>

          {trace.error && (
            <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 p-5">
              <h2 className="text-lg font-bold text-red-600 dark:text-red-400">
                {trace.error.title}
              </h2>
              {trace.error.code && (
                <p className="mt-0.5 font-mono text-xs text-neutral-500">{trace.error.code}</p>
              )}
              <p className="mt-3 text-sm leading-relaxed">
                <span className="font-semibold">Why it failed: </span>
                {trace.error.cause}
              </p>
              <p className="mt-2 text-sm leading-relaxed">
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  How to fix it:{" "}
                </span>
                {trace.error.fix}
              </p>
            </div>
          )}

          <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Instruction tree
          </h2>
          <ul className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
            {trace.tree.map((n) => (
              <Node key={n.index} node={n} />
            ))}
          </ul>

          {trace.logs.length > 0 && (
            <details className="mt-6">
              <summary className="cursor-pointer text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Raw program logs ({trace.logs.length})
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-xl border border-neutral-200 p-4 text-xs leading-relaxed dark:border-neutral-800">
                {trace.logs.join("\n")}
              </pre>
            </details>
          )}
        </>
      )}
    </main>
  );
}
