import type { Metadata } from "next";
import Link from "next/link";
import { readStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Usage | TxWhy",
  description: "Live, public usage numbers for TxWhy: diagnoses, repairs, success rate and the most common Solana transaction failures.",
};

const STATUS_LABEL: Record<string, string> = {
  repaired: "Repaired",
  valid: "Already valid",
  needs_requote: "Needs a fresh quote",
  not_repairable: "Not repairable",
};

const CHANNEL_LABEL: Record<string, string> = {
  web: "Website",
  api: "API",
  mcp: "Agents (MCP)",
  telegram: "Telegram bot",
};

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

function Bars({ rows }: { rows: { label: string; value: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="mt-3 space-y-2">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="flex justify-between gap-4">
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-neutral-500">{r.value.toLocaleString("en-US")}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800">
            <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function StatsPage() {
  const stats = await readStats();
  const n = (v: number) => v.toLocaleString("en-US");

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
          <Link href="/#api" className="hover:text-emerald-500">
            API
          </Link>
        </nav>
      </header>

      <h1 className="mt-8 text-2xl font-bold tracking-tight">Usage, in the open</h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        Every number here is counted by the service itself and updates live. No addresses, transactions or IPs are
        stored. Unique callers are estimated from salted hashes that cannot be reversed.
      </p>

      {!stats ? (
        <p className="mt-8 rounded-xl border border-neutral-200 p-5 text-sm text-neutral-500 dark:border-neutral-800">
          Counting has not started yet. Numbers appear here as soon as storage is attached.
        </p>
      ) : (
        <>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label="Diagnoses" value={n(stats.diagnoses)} />
            <Tile label="Repair attempts" value={n(stats.repairs)} />
            <Tile
              label="Came back working"
              value={stats.repairs ? `${Math.round((stats.repaired / stats.repairs) * 100)}%` : "0%"}
              hint={`${n(stats.repaired)} passed simulation`}
            />
            <Tile label="Unique callers" value={n(stats.callers)} hint="estimated" />
          </div>

          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Last 14 days</h2>
            <div className="mt-3 flex h-28 items-end gap-1">
              {stats.days.map((d) => {
                const total = d.diagnoses + d.repairs;
                const max = Math.max(1, ...stats.days.map((x) => x.diagnoses + x.repairs));
                return (
                  <div key={d.day} className="flex flex-1 flex-col items-center gap-1" title={`${d.day}: ${total}`}>
                    <div
                      className="w-full rounded-t bg-emerald-500/80"
                      style={{ height: `${Math.max(total ? 4 : 0, (total / max) * 100)}%` }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-xs text-neutral-500">
              <span>{stats.days[0]?.day}</span>
              <span>{stats.days[stats.days.length - 1]?.day}</span>
            </div>
          </section>

          <div className="mt-10 grid gap-8 sm:grid-cols-2">
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Repair outcomes</h2>
              <Bars
                rows={Object.entries(stats.status)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => ({ label: STATUS_LABEL[k] ?? k, value: v }))}
              />
            </section>
            <section>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Where it is used</h2>
              <Bars
                rows={Object.entries(stats.channel)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => ({ label: CHANNEL_LABEL[k] ?? k, value: v }))}
              />
            </section>
          </div>

          <section className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Most common failures seen</h2>
            {stats.topErrors.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">Nothing yet.</p>
            ) : (
              <Bars rows={stats.topErrors.map((e) => ({ label: e.title, value: e.count }))} />
            )}
          </section>
        </>
      )}
    </main>
  );
}
