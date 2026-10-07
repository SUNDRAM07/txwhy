"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useId, useState } from "react";

export interface CodeTab {
  id: string;
  label: string;
  install: string;
  code: string;
}

const FADE = { duration: 0.12, ease: [0.33, 1, 0.68, 1] as const };

/** One rule, three languages: a small, keyboard-friendly tab strip over a code block. */
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(tabs[0].id);
  const reduced = useReducedMotion();
  const base = useId();
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  function onKey(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setActive(tabs[next].id);
    (document.getElementById(`${base}-tab-${tabs[next].id}`) as HTMLButtonElement | null)?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label="Language" className="flex gap-1 rounded-lg bg-neutral-100 p-1 dark:bg-neutral-900">
        {tabs.map((t, i) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              id={`${base}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${base}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={`relative min-h-10 flex-1 rounded-md px-3 text-sm font-medium transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none ${
                selected ? "text-neutral-900 dark:text-neutral-50" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
              }`}
            >
              {selected && (
                <motion.span
                  layoutId={`${base}-pill`}
                  transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 30 }}
                  className="absolute inset-0 rounded-md bg-white shadow-sm dark:bg-neutral-800"
                  aria-hidden
                />
              )}
              <span className="relative">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div id={`${base}-panel`} role="tabpanel" className="mt-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={FADE}
          >
            <pre className="overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">{current.install}</pre>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">{current.code}</pre>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
