"use client";

import Link from "next/link";
import { useState } from "react";
import { RepairView, useRepair } from "@/components/RepairPanel";

export default function RepairPage() {
  const [input, setInput] = useState("");
  const repair = useRepair();
  const [submitted, setSubmitted] = useState(false);

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

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          const transaction = input.trim();
          if (!transaction) return;
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

      {submitted && <RepairView result={repair.result} error={repair.error} loading={repair.loading} />}

      <p className="mt-8 text-xs leading-relaxed text-neutral-500">
        Building an agent or a bot? Call it directly:{" "}
        <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">
          POST /api/v1/repair
        </code>{" "}
        with a JSON body containing either <code>transaction</code> (base64) or{" "}
        <code>signature</code>.
      </p>
    </main>
  );
}
