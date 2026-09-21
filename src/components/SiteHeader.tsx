import Link from "next/link";

const LINKS: { href: string; label: string; wide?: boolean }[] = [
  { href: "/repair", label: "Repair" },
  { href: "/errors", label: "Error codes" },
  { href: "/failures", label: "Failure index" },
  { href: "/#api", label: "API" },
  { href: "/stats", label: "Usage", wide: true },
];

export function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4">
      <Link href="/" className="font-bold tracking-tight">
        Tx<span className="text-emerald-500">Why</span>
      </Link>
      <nav className="flex min-w-0 gap-4 overflow-x-auto text-sm whitespace-nowrap text-neutral-500 sm:gap-5">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={`hover:text-emerald-500 ${l.wide ? "hidden sm:inline" : ""}`}>
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
