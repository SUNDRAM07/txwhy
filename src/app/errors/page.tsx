import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { catalogSize, listPrograms } from "@/lib/catalog";

export const metadata: Metadata = {
  title: "Solana error codes, decoded | TxWhy",
  description:
    "Look up any Solana custom program error: Jupiter, Raydium, Orca, Meteora, Pump.fun, Drift, Metaplex, Anchor, SPL Token and more. Hex or decimal, with the cause and the fix.",
};

function search(q: string) {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  const code = /^0x[0-9a-f]+$/.test(term) ? parseInt(term, 16) : /^\d+$/.test(term) ? Number(term) : null;
  const out = [];
  for (const program of listPrograms()) {
    for (const error of program.errors) {
      const hit = code != null ? error.code === code : error.name.toLowerCase().includes(term) || program.name.toLowerCase().includes(term);
      if (hit) out.push({ program, error });
      if (out.length >= 80) return out;
    }
  }
  return out;
}

export default async function ErrorsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const results = search(q);
  const programs = listPrograms();

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl px-4 py-10">
      <SiteHeader />

      <h1 className="mt-8 text-2xl font-bold tracking-tight">Solana error codes, decoded</h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        {catalogSize().toLocaleString("en-US")} error codes across {programs.length} programs. The same number means
        different things in different programs, so <code>0x1771</code> on Jupiter is not <code>0x1771</code> on Raydium.
        Search a code and see every program that uses it.
      </p>

      <form action="/errors" className="mt-6 flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="0x1771, 6001 or SlippageToleranceExceeded"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-2.5 font-mono text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button type="submit" className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white transition hover:bg-emerald-500">
          Look up
        </button>
      </form>

      {q && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {results.length === 0 ? "No match" : `${results.length}${results.length >= 80 ? "+" : ""} match${results.length === 1 ? "" : "es"} for "${q}"`}
          </h2>
          {results.length === 0 ? (
            <p className="mt-3 text-sm leading-relaxed text-neutral-500">
              Nothing published uses that code. About half of the failures on the big exchanges come from private bot
              programs that publish no error list. If you have the failed transaction,{" "}
              <Link href="/" className="text-emerald-600 hover:underline dark:text-emerald-400">
                paste its signature
              </Link>{" "}
              and TxWhy will show exactly which program raised it.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-neutral-200 dark:divide-neutral-800">
              {results.map(({ program, error }) => (
                <li key={`${program.slug}-${error.code}`}>
                  <Link href={`/errors/${program.slug}/${error.code}`} className="block py-3 hover:text-emerald-600 dark:hover:text-emerald-400">
                    <span className="font-mono text-xs text-neutral-500">
                      {error.code} · {error.hex}
                    </span>
                    <span className="ml-3 font-semibold">{error.name}</span>
                    <span className="ml-2 text-sm text-neutral-500">{program.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Browse by program</h2>
        <ul className="mt-3 grid gap-x-8 sm:grid-cols-2">
          {programs.map((p) => (
            <li key={p.slug} className="border-b border-neutral-200 dark:border-neutral-800">
              <Link href={`/errors/${p.slug}`} className="flex justify-between gap-4 py-2.5 text-sm hover:text-emerald-600 dark:hover:text-emerald-400">
                <span className="truncate">{p.name}</span>
                <span className="shrink-0 tabular-nums text-neutral-500">{p.errors.length}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-10 text-sm leading-relaxed text-neutral-500">
        A code only tells you what went wrong.{" "}
        <Link href="/repair" className="text-emerald-600 hover:underline dark:text-emerald-400">
          TxWhy also hands back a transaction that works →
        </Link>
      </p>
    </main>
  );
}
