"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { extractSignature } from "@/lib/trace";

export default function Home() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const sig = extractSignature(input);
    if (!sig) {
      setError("That doesn't look like a transaction signature or explorer link.");
      return;
    }
    setError(null);
    setLoading(true);
    router.push(`/tx/${sig}`);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-8 px-4">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          Tx<span className="text-emerald-500">Why</span>
        </h1>
        <p className="mt-3 text-lg text-neutral-500 dark:text-neutral-400">
          Paste a failed Solana transaction. See why it failed — and how to fix it.
        </p>
      </div>

      <form onSubmit={submit} className="w-full">
        <div className="flex w-full gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Transaction signature or explorer URL"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-3 font-mono text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-emerald-600 px-5 py-3 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {loading ? "Tracing…" : "Explain"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
      </form>

      <p className="text-center text-sm text-neutral-400 dark:text-neutral-500">
        Decoded instruction tree · failing step highlighted · plain-English cause + fix ·
        shareable link
      </p>
    </main>
  );
}
