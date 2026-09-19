"use client";

import Link from "next/link";
import { useState } from "react";
import { RepairView, useRepair } from "@/components/RepairPanel";

const DEMOS = [
  { kind: "compute", label: "Compute limit too low" },
  { kind: "blockhash", label: "Expired blockhash" },
  { kind: "slippage", label: "Swap on a stale quote" },
];

export default function RepairPage() {
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [demo, setDemo] = useState<{ description: string } | { error: string } | null>(null);
  const [loadingDemo, setLoadingDemo] = useState<string | null>(null);
  const repair = useRepair();

  async function loadDemo(kind: string) {
    setLoadingDemo(kind);
    setDemo(null);
    try {
      const res = await fetch(`/api/v1/example?kind=${kind}`);
      const body = await res.json();
      if (!res.ok || !body.transaction) {
        setDemo({ error: body.error ?? "Could not build the demo transaction." });
        return;
      }
      setInput(body.transaction);
      setDemo({ description: body.description });
      setSubmitted(true);
      void repair.run({ transaction: body.transaction });
    } catch {
      setDemo({ error: "Could not reach the demo service." });
    } finally {
      setLoadingDemo(null);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <Link href="/" className="font-bold tracking-tight">
        Tx<span className="text-emerald-500">Why</span>
      </Link>
      <h1 className="mt-6 text-2xl font-bold tracking-tight">
        Repair a transaction before you send it
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        Paste a serialized transaction in base64, signed or unsigned. TxWhy simulates it against live
        chain state, fixes what can be fixed, and returns a rebuilt unsigned transaction with proof
        that it passes.
      </p>

      <div className="mt-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
        <p className="text-sm font-semibold">No transaction handy? Watch a live repair.</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          Each button builds a real, deliberately broken transaction on mainnet state and repairs it
          in front of you. The demo uses a public exchange wallet as the payer, so nobody can sign or
          send these.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {DEMOS.map((d) => (
            <button
              key={d.kind}
              onClick={() => loadDemo(d.kind)}
              disabled={loadingDemo !== null}
              className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-neutral-700 dark:hover:text-emerald-400"
            >
              {loadingDemo === d.kind ? "Building…" : d.label}
            </button>
          ))}
        </div>
        {demo && "description" in demo && (
          <p className="mt-3 text-xs text-neutral-500">Loaded: {demo.description}</p>
        )}
        {demo && "error" in demo && <p className="mt-3 text-xs text-red-500">{demo.error}</p>}
      </div>

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          const transaction = input.trim();
          if (!transaction) return;
          setDemo(null);
          setSubmitted(true);
          void repair.run({ transaction });
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Base64 transaction"
          spellCheck={false}
          rows={5}
          className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-3 font-mono text-xs outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          className="mt-2 rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white transition hover:bg-emerald-500"
        >
          Repair
        </button>
      </form>

      {submitted && (
        <RepairView result={repair.result} error={repair.error} loading={repair.loading} />
      )}

      <p className="mt-8 text-xs leading-relaxed text-neutral-500">
        Building an agent or a bot? Call it directly:{" "}
        <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">
          POST /api/v1/repair
        </code>{" "}
        with a JSON body containing either <code>transaction</code> (base64) or{" "}
        <code>signature</code>. See the <Link href="/#api" className="underline">API section</Link>.
      </p>
    </main>
  );
}
