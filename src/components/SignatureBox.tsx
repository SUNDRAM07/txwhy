"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { extractSignature } from "@/lib/trace";

/** Signature or explorer link in, /tx/<signature> out. */
export function SignatureBox({ cta = "Diagnose" }: { cta?: string }) {
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
    <form onSubmit={submit}>
      <div className="flex w-full gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Transaction signature or explorer URL"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 font-mono text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
        >
          {loading ? "Tracing…" : cta}
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </form>
  );
}
