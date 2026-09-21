import type { Metadata } from "next";
import Link from "next/link";
import { readFailureIndex } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Solana failure index | TxWhy",
  description:
    "A live sample of failed transactions on Solana's busiest programs: how many fail, where, why, and how many failures come from private bot programs.",
};

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const n = (v: number) => v.toLocaleString("en-US");

function Bars({ rows, suffix }: { rows: { label: string; value: number; note?: string }[]; suffix?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="mt-3 space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex justify-between gap-4">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-neutral-500">
              {r.note ?? n(r.value)}
              {suffix}
            </span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800">
            <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function FailuresPage() {
  const index = await readFailureIndex();
  const privateShare =
    index && index.classified > 0 ? (index.source["private program"] ?? 0) / index.classified : null;

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl px-4 py-10">
      <header className="flex items-center justify-between">
        <Link href="/" className="font-bold tracking-tight">
          Tx<span className="text-emerald-500">Why</span>
        </Link>
        <nav className="flex gap-5 text-sm text-neutral-500">
          <Link href="/repair" className="hover:text-emerald-500">
            Repair
          </Link>
          <Link href="/stats" className="hover:text-emerald-500">
            Usage
          </Link>
        </nav>
      </header>

      <h1 className="mt-8 text-2xl font-bold tracking-tight">Solana failure index</h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        A worker samples recent transactions on six of Solana&apos;s busiest programs around the clock, and classifies
        a slice of the failures with the same engine that powers TxWhy. This is a running sample, not a census.
      </p>

      {!index || index.transactionsSeen === 0 ? (
        <p className="mt-8 rounded-xl border border-neutral-200 p-5 text-sm text-neutral-500 dark:border-neutral-800">
          The index is warming up. Numbers appear here once the worker has completed its first pass.
        </p>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Transactions sampled", n(index.transactionsSeen)],
              ["Failed", n(index.failed)],
              ["Failure rate", pct(index.failureRate)],
              ["From private bots", privateShare == null ? "n/a" : pct(privateShare)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
                <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-neutral-500">
            {index.since && `Sampling since ${new Date(index.since).toUTCString()}. `}
            {index.updatedAt && `Last pass ${new Date(index.updatedAt).toUTCString()}. `}
            {`"From private bots" is the share of ${n(index.classified)} classified failures raised by programs that publish no error list.`}
          </p>

          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Failure rate by program</h2>
            <Bars
              rows={index.byProgram.map((p) => ({
                label: p.program,
                value: p.failureRate * 100,
                note: `${pct(p.failureRate)} of ${n(p.seen)}`,
              }))}
            />
          </section>

          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Why they fail</h2>
              <p className="mt-1 text-xs text-neutral-500">Named causes, from programs that publish their errors.</p>
              <Bars rows={index.topCauses.map((c) => ({ label: c.title, value: c.count }))} />
            </section>
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Who raised the error</h2>
              <p className="mt-1 text-xs text-neutral-500">The innermost program that failed.</p>
              <Bars rows={index.topCulprits.map((c) => ({ label: c.program, value: c.count }))} />
            </section>
          </div>

          <p className="mt-10 text-sm leading-relaxed text-neutral-500">
            Most failures on these programs are automated traders firing transactions they expect to miss. The ones
            that hurt are the rest: an agent or an app whose swap, payment or transfer should have worked.{" "}
            <Link href="/repair" className="text-emerald-600 hover:underline dark:text-emerald-400">
              That is what TxWhy repairs →
            </Link>
          </p>
        </>
      )}
    </main>
  );
}
