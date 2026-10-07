"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";

const WITHOUT = `SendTransactionError: Simulation failed.
Message: Transaction simulation failed: Error processing
Instruction 2: custom program error: 0x1771
Logs:
  Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]
  Program log: AnchorError occurred. Error Code:
    SlippageToleranceExceeded. Error Number: 6001.
  Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed:
    custom program error: 0x1771

→ retry blind, widen slippage, or give up. The fee is gone either way.`;

const WITH = `status        repaired
cause         SlippageToleranceExceeded (0x1771)
              the price moved past your 2.53% tolerance

changes       swap_quote   receive at least 478.51 → 677.68 7CTR
              blockhash    refreshed
              priority_fee 71,431 → 109,586 micro-lamports per CU
                           (75th percentile for these accounts)

simulation    passed · 133,939 compute units
verification  3 instructions kept byte for byte · nothing else was touched

→ sign it with your own key, or refuse it. Your call, with the evidence.`;

export function BeforeAfter() {
  const [side, setSide] = useState<"without" | "with">("without");
  const reduced = useReducedMotion();
  const options = [
    { id: "without" as const, label: "Without TxWhy" },
    { id: "with" as const, label: "With TxWhy" },
  ];

  return (
    <div>
      <div role="tablist" aria-label="Before and after" className="inline-flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900">
        {options.map((o) => {
          const selected = o.id === side;
          return (
            <button
              key={o.id}
              role="tab"
              type="button"
              aria-selected={selected}
              onClick={() => setSide(o.id)}
              className={`relative min-h-10 rounded-md px-4 text-sm font-medium transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${selected ? "text-neutral-900 dark:text-neutral-50" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"}`}
            >
              {selected && <motion.span layoutId="before-after-pill" transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 30 }} className="absolute inset-0 rounded-md bg-white shadow-sm dark:bg-neutral-800" aria-hidden />}
              <span className="relative">{o.label}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3" role="tabpanel">
        <AnimatePresence mode="wait" initial={false}>
          <motion.pre
            key={side}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={{ duration: 0.12 }}
            className={`overflow-x-auto rounded-xl border p-4 font-mono text-xs leading-relaxed whitespace-pre ${
              side === "without" ? "border-red-500/30 bg-red-500/5 text-neutral-700 dark:text-neutral-300" : "border-emerald-500/30 bg-emerald-500/5 text-neutral-800 dark:text-neutral-200"
            }`}
          >
            {side === "without" ? WITHOUT : WITH}
          </motion.pre>
        </AnimatePresence>
      </div>
    </div>
  );
}
