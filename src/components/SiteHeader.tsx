import Link from "next/link";

const LINKS: { href: string; label: string; wide?: boolean }[] = [
  { href: "/repair", label: "Repair" },
  { href: "/errors", label: "Error codes" },
  { href: "/failures", label: "Failure index" },
  { href: "/#api", label: "API" },
  { href: "/stats", label: "Usage", wide: true },
];

const link = "rounded px-1 py-2 transition-colors duration-100 hover:text-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:hover:text-emerald-400";

/** Sticky and translucent, so the wordmark and the way back are always one glance away. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 -mx-4 flex items-center justify-between gap-4 border-b border-neutral-200/70 bg-white/75 px-4 py-2 backdrop-blur-md sm:-mx-6 sm:px-6 dark:border-neutral-800/70 dark:bg-neutral-950/75">
      <Link href="/" className="rounded font-bold tracking-tight focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none">
        Tx<span className="text-emerald-500">Why</span>
      </Link>
      <nav className="flex min-w-0 items-center gap-2 overflow-x-auto text-sm whitespace-nowrap text-neutral-600 sm:gap-3 dark:text-neutral-400" aria-label="Site">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={`${link} ${l.wide ? "hidden sm:inline" : ""}`}>
            {l.label}
          </Link>
        ))}
        <a href="https://github.com/SUNDRAM07/txwhy" className={`${link} hidden items-center gap-1 sm:inline-flex`} aria-label="TxWhy on GitHub">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
        </a>
      </nav>
    </header>
  );
}
