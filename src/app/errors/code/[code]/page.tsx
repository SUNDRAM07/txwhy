import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { SignatureBox } from "@/components/SignatureBox";
import { SiteHeader } from "@/components/SiteHeader";
import { listCodes, programsForCode } from "@/lib/catalog";

/**
 * "custom program error: 0x1771" is what people see and search for, but a custom code only has a
 * meaning inside the program that raised it. This page lists every program we know that uses the
 * code, most-hit programs first, so the reader can find theirs without already knowing the program.
 */

type Params = Promise<{ code: string }>;

const parse = (raw: string): number | null =>
  /^0x[0-9a-f]+$/i.test(raw) ? parseInt(raw, 16) : /^\d+$/.test(raw) ? Number(raw) : null;
const hexOf = (code: number) => `0x${code.toString(16)}`;

export function generateStaticParams() {
  return listCodes().map((code) => ({ code: hexOf(code) }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const code = parse((await params).code);
  const hits = code == null ? [] : programsForCode(code);
  if (code == null || hits.length === 0) return { title: "Unknown error code | TxWhy" };
  const names = hits.slice(0, 3).map((h) => `${h.error.name} (${h.program.name})`).join(", ");
  const title = `custom program error: ${hexOf(code)} (${code}) on Solana: what it means | TxWhy`;
  const description = `${hexOf(code)} is a different error in each program: ${names}${hits.length > 3 ? ` and ${hits.length - 3} more` : ""}. Find the one that failed your transaction.`.slice(0, 300);
  return { title, description, alternates: { canonical: `/errors/code/${hexOf(code)}` }, openGraph: { title, description } };
}

export default async function CodePage({ params }: { params: Params }) {
  const raw = (await params).code;
  const code = parse(raw);
  if (code == null) notFound();
  const hits = programsForCode(code);
  if (hits.length === 0) notFound();
  const hex = hexOf(code);
  if (raw !== hex) permanentRedirect(`/errors/code/${hex}`);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What does "custom program error: ${hex}" mean on Solana?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `${hex} (decimal ${code}) has no single meaning: custom codes belong to the program that raised them. ${hits
            .slice(0, 4)
            .map((h) => `In ${h.program.name} it is ${h.error.name}: ${h.error.cause}`)
            .join(" ")}`,
        },
      },
      {
        "@type": "Question",
        name: `How do I know which program raised ${hex}?`,
        acceptedAnswer: {
          "@type": "Answer",
          text: `Look at the transaction's logs for the first line of the form "Program <address> failed: custom program error: ${hex}". That address is the program whose meaning applies, and it is often not the program you called but one it invoked, or a guard instruction your wallet added.`,
        },
      },
    ],
  };

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl px-4 py-10">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <SiteHeader />

      <p className="mt-8 text-sm text-neutral-500">
        <Link href="/errors" className="hover:text-emerald-500">
          Error codes
        </Link>{" "}
        / {hex}
      </p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight break-words">custom program error: {hex}</h1>
      <p className="mt-1 font-mono text-sm text-neutral-500">
        Custom({code}) · {hex} · used by {hits.length} program{hits.length === 1 ? "" : "s"} we know
      </p>

      <section className="mt-6 rounded-xl bg-neutral-100 p-4 dark:bg-neutral-900">
        <p className="text-sm leading-relaxed">
          This number has no meaning on its own. Each Solana program numbers its own errors, so {hex} is{" "}
          <strong>{hits[0].error.name}</strong> in {hits[0].program.name}
          {hits[1] && (
            <>
              {" "}
              but <strong>{hits[1].error.name}</strong> in {hits[1].program.name}
            </>
          )}
          . The meaning that applies is the one from the program that actually failed: the first{" "}
          <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">Program … failed</code> line in the
          transaction&apos;s logs. That is often not the program you called, but one it invoked, or a guard instruction
          your wallet added.
        </p>
      </section>

      <section className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
        <h2 className="text-sm font-semibold">Don&apos;t guess: paste the transaction</h2>
        <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          TxWhy reads the logs, finds the program and the exact instruction that raised {hex}, explains it, and rebuilds
          the transaction when the cause is one it can fix.
        </p>
        <div className="mt-3">
          <SignatureBox cta="Diagnose" />
        </div>
      </section>

      <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-neutral-500">What {hex} means, by program</h2>
      <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
        {hits.map((h) => (
          <li key={h.program.slug} className="py-3">
            <Link href={`/errors/${h.program.slug}/${h.error.code}`} className="group block">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <span className="font-semibold group-hover:text-emerald-600 dark:group-hover:text-emerald-400">{h.error.name}</span>
                <span className="text-sm text-neutral-500">{h.program.name}</span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{h.error.cause}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
