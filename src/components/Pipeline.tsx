"use client";

/* ─────────────────────────────────────────────────────────
 * PIPELINE
 *
 * Six stages in a row. When the row scrolls into view a pulse
 * runs once along the connecting line (CSS dash offset), then
 * the line idles. Each stage is a button: pick one to read what
 * it does and what it refuses. Reduced motion: no pulse.
 * ───────────────────────────────────────────────────────── */

import { AnimatePresence, motion, useInView, useReducedMotion } from "framer-motion";
import { useRef, useState } from "react";

const STAGES = [
  { id: "decode", label: "Decode", ms: "~5 ms", does: "Reads the transaction as sent: legacy, v0 with lookup tables, or version 1. Nothing is trusted from the caller except the bytes.", refuses: "Malformed bytes, a payer that is a program, too many account locks: answered as a diagnosis, never a 500." },
  { id: "simulate", label: "Simulate", ms: "~300 ms", does: "Runs the transaction as submitted and again at the maximum compute budget, in parallel, against live chain state. The logs and the error are the evidence.", refuses: "A lagging node that rejects the fresh blockhash is retried, not reported as your fault." },
  { id: "classify", label: "Classify", ms: "~1 ms", does: "Walks every inner call to the exact instruction that failed, decodes the program's own error, and decides which repair applies, if any.", refuses: "Circular arbitrage, wallet guards, private programs and empty wallets get a named cause and no false hope." },
  { id: "rebuild", label: "Rebuild", ms: "~400 ms", does: "Applies only the fix that matches: budget, blockhash, fee, a re-quoted Jupiter swap, or a direct swap's limit moved to the price the chain itself computed.", refuses: "A route above 3% price impact, a quote or limit more than 25% worse, a chained swap: refused, with the reason." },
  { id: "prove", label: "Prove", ms: "~300 ms", does: "Simulates the rebuilt transaction. It comes back only if it passes, with the compute units it used.", refuses: "A rebuild that still fails is withheld. You never get a transaction that would fail again." },
  { id: "verify", label: "Verify", ms: "0 ms, on your machine", does: "Your copy of the open-source checker compares the two transactions instruction by instruction, offline, before anything is signed.", refuses: "Same payer, same signers, everything else byte for byte. Anything outside the rule is a reason not to sign." },
];

export function Pipeline() {
  const [active, setActive] = useState(STAGES[3].id);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduced = useReducedMotion();
  const current = STAGES.find((s) => s.id === active) ?? STAGES[0];

  return (
    <div ref={ref}>
      <div className="relative">
        <div
          className={`pointer-events-none absolute top-[22px] right-6 left-6 hidden h-px bg-neutral-200 sm:block dark:bg-neutral-800 ${inView && !reduced ? "pipeline-pulse" : ""}`}
          aria-hidden
        />
        <ol className="relative grid grid-cols-2 gap-2 sm:grid-cols-6" role="tablist" aria-label="Pipeline stages">
          {STAGES.map((s, i) => {
            const selected = s.id === active;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActive(s.id)}
                  className={`group flex min-h-11 w-full flex-col items-center gap-1 rounded-xl px-2 py-2 text-center transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${selected ? "text-neutral-900 dark:text-neutral-50" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"}`}
                >
                  <motion.span
                    initial={reduced ? false : { scale: 0.6, opacity: 0 }}
                    animate={inView || reduced ? { scale: 1, opacity: 1 } : {}}
                    transition={{ type: "spring", stiffness: 350, damping: 24, delay: reduced ? 0 : 0.1 + i * 0.12 }}
                    className={`flex h-8 w-8 items-center justify-center rounded-full border font-mono text-xs transition-colors duration-100 ${selected ? "border-emerald-500 bg-emerald-500 text-white" : "border-neutral-300 bg-white group-hover:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-950"}`}
                    aria-hidden
                  >
                    {i + 1}
                  </motion.span>
                  <span className="text-sm font-semibold">{s.label}</span>
                  <span className="text-[11px] text-neutral-500">{s.ms}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="mt-4 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800" role="tabpanel">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={current.id} initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={reduced ? undefined : { opacity: 0 }} transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }} className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-400">What it does</p>
              <p className="mt-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">{current.does}</p>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">What it refuses</p>
              <p className="mt-1 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">{current.refuses}</p>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
