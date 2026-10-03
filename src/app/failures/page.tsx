import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { readFailureIndex } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Solana failure index | TxWhy",
  description:
    "A live sample of failed transactions on Solana's busiest programs: how many fail, where, why, and how many failures come from private bot programs.",
};

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const n = (v: number) => v.toLocaleString("en-US");

function Bars({ rows, suffix }: { rows: { label: string; value: number; note?: string; sub?: string }[]; suffix?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="mt-3 space-y-2">
      {rows.map((r) => (
        <li key={r.label + (r.sub ?? "")} className="text-sm">
          <div className="flex justify-between gap-4">
            <span className="min-w-0">
              <span className="block truncate">{r.label}</span>
              {r.sub && <span className="block truncate text-xs text-neutral-500">{r.sub}</span>}
            </span>
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
      <SiteHeader />

      <h1 className="mt-8 text-2xl font-bold tracking-tight">Solana failure index</h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">
        A worker samples recent transactions on nine of Solana&apos;s busiest programs around the clock, and classifies
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

          {index.repair && index.repair.attempted > 0 && (
            <section className="mt-10 rounded-2xl border border-neutral-200 p-5 dark:border-neutral-800">
              <h2 className="text-lg font-semibold">Could TxWhy have fixed it?</h2>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                The worker also pushes a sample of these real, already-landed failures through the repair engine and
                records only the verdict. Landed failures are the hard case: the price has moved and the blockhash has
                expired by the time we see them, so this is a floor, not a ceiling, for what pre-send repair achieves.
              </p>
              {index.repair.segments && index.repair.segments.people > 0 ? (
                <>
                  <p className="mt-4 text-sm leading-relaxed">
                    Of {n(index.repair.attempted)} real failures pushed through the engine,{" "}
                    <strong>{pct(index.repair.segments.bots / index.repair.attempted)}</strong> were automated traders that
                    were meant to fail once the opportunity was gone (private bot programs and circular arbitrage). Nobody
                    can or should repair those. The rest, {n(index.repair.segments.people)}, are the failures a person or
                    an app would care about:
                  </p>
                  <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      ["Rebuilt and verified", pct(index.repair.segments.rebuilt / index.repair.segments.people), `${n(index.repair.segments.rebuilt)} transactions`],
                      ["Price moved too far", pct(index.repair.segments.movedTooFar / index.repair.segments.people), "stale by the time it landed"],
                      ["Wallet guard tripped", pct(index.repair.segments.guards / index.repair.segments.people), "needs a fresh transaction"],
                      ["No rebuild can fix", pct(index.repair.segments.deadEnds / index.repair.segments.people), "no funds, overflow, used nonce"],
                    ].map(([k, v, note]) => (
                      <div key={k} className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-900">
                        <dt className="text-xs text-neutral-500">{k}</dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">{v}</dd>
                        <dd className="mt-0.5 text-[11px] leading-tight text-neutral-500">{note}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-xs text-neutral-500">Average time per attempt: {(index.repair.averageMs / 1000).toFixed(1)} s.</p>
                </>
              ) : (
                <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ["Attempted", n(index.repair.attempted)],
                    ["Rebuilt and verified", pct(index.repair.repairedRate)],
                    ["Moved too far", n(index.repair.verdicts.moved_too_far ?? 0)],
                    ["Average time", `${(index.repair.averageMs / 1000).toFixed(1)} s`],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-xl bg-neutral-50 p-3 dark:bg-neutral-900">
                      <dt className="text-xs text-neutral-500">{k}</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums">{v}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-5 grid gap-6 sm:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold">Rebuilt, by program</h3>
                  <Bars
                    rows={Object.entries(index.repair.repairedByProgram)
                      .sort((a, b) => b[1] - a[1])
                      .map(([label, value]) => ({ label, value }))}
                  />
                </div>
                <div>
                  <h3 className="text-sm font-semibold">Why the rest could not be</h3>
                  <p className="mt-1 text-xs text-neutral-500">Ranked by how often real senders hit it. This list decides what gets built next.</p>
                  <Bars rows={index.repair.unrepairable.map((c) => { const i = c.title.indexOf(": "); return i > 0 ? { label: c.title.slice(0, i), sub: c.title.slice(i + 2), value: c.count } : { label: c.title, value: c.count }; })} />
                </div>
              </div>
              {index.repair.engineErrors.length > 0 && (
                <p className="mt-4 text-xs text-amber-600 dark:text-amber-400">
                  Engine errors seen: {index.repair.engineErrors.map((e) => `${e.title} (${e.count})`).join("; ")}
                </p>
              )}
              {index.repair.last && (
                <p className="mt-3 text-xs text-neutral-500">
                  Last attempt {new Date(index.repair.last.at).toUTCString()}: {index.repair.last.program}, {index.repair.last.verdict.replace(/_/g, " ")}
                  {index.repair.last.detail ? ` (${index.repair.last.detail})` : ""}, {(index.repair.last.ms / 1000).toFixed(1)} s.
                </p>
              )}
            </section>
          )}

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
