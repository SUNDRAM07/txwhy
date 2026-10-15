import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { SignatureBox } from "@/components/SignatureBox";
import { SiteHeader } from "@/components/SiteHeader";
import { getError, listPrograms, sameCodeElsewhere } from "@/lib/catalog";
import { fieldNote, repairBlurb } from "@/lib/field-notes";

type Params = Promise<{ program: string; code: string }>;

export function generateStaticParams() {
  return listPrograms().flatMap((p) => p.errors.map((e) => ({ program: p.slug, code: String(e.code) })));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { program, code } = await params;
  const hit = getError(program, code);
  if (!hit) return { title: "Unknown error code | TxWhy" };
  const { error } = hit;
  const title = `${hit.program.name} error ${error.code} (${error.hex}): ${error.name} | TxWhy`;
  const description = `custom program error: ${error.hex} on ${hit.program.name} is ${error.name}. ${error.cause}`.slice(0, 300);
  return {
    title,
    description,
    alternates: { canonical: `/errors/${hit.program.slug}/${error.code}` },
    openGraph: { title, description },
  };
}

export default async function ErrorCodePage({ params }: { params: Params }) {
  const { program: slug, code } = await params;
  const hit = getError(slug, code);
  if (!hit) notFound();
  const { program, error } = hit;
  if (code !== String(error.code)) permanentRedirect(`/errors/${program.slug}/${error.code}`);

  const elsewhere = sameCodeElsewhere(error.code, program.slug);
  const seen = fieldNote(program.address, error.name);
  const blurb = repairBlurb(program.address, error.repair);
  const position = program.errors.findIndex((e) => e.code === error.code);
  const previous = program.errors[position - 1];
  const next = program.errors[position + 1];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `What does ${program.name} error ${error.code} (${error.hex}) mean?`,
        acceptedAnswer: { "@type": "Answer", text: `${error.name}. ${error.cause}` },
      },
      {
        "@type": "Question",
        name: `How do I fix ${error.name} on ${program.name}?`,
        acceptedAnswer: { "@type": "Answer", text: error.fix },
      },
      ...(seen
        ? [
            {
              "@type": "Question",
              name: `What does ${error.name} on ${program.name} look like on mainnet?`,
              acceptedAnswer: { "@type": "Answer", text: seen },
            },
          ]
        : []),
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
        /{" "}
        <Link href={`/errors/${program.slug}`} className="hover:text-emerald-500">
          {program.name}
        </Link>
      </p>

      <h1 className="mt-2 text-2xl font-bold tracking-tight break-words">{error.name}</h1>
      <p className="mt-1 font-mono text-sm text-neutral-500">
        {program.name} · Custom({error.code}) · {error.hex}
      </p>
      <p className="mt-1 font-mono text-xs break-words text-neutral-500">custom program error: {error.hex}</p>

      <section className="mt-6 rounded-xl bg-neutral-100 p-4 dark:bg-neutral-900">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">What it means</h2>
        <p className="mt-1 text-sm leading-relaxed">{error.cause}</p>
        {error.message && error.message !== error.cause && (
          <p className="mt-2 text-xs text-neutral-500">The program&apos;s own message: &ldquo;{error.message}&rdquo;</p>
        )}
        <h2 className="mt-4 text-xs font-semibold uppercase tracking-wide text-neutral-500">What to do</h2>
        <p className="mt-1 text-sm leading-relaxed">{error.fix}</p>
      </section>

      {seen && (
        <section className="mt-6 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Seen on mainnet</h2>
          <p className="mt-1 text-sm leading-relaxed">{seen}</p>
          <p className="mt-2 text-xs text-neutral-500">
            From replaying real landed failures through the repair engine, around the clock since September 21, 2026. Every verdict and its reason is on the{" "}
            <Link href="/failures" className="underline hover:text-emerald-500">
              failure index
            </Link>
            .
          </p>
        </section>
      )}

      <section className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
        <h2 className="text-sm font-semibold">{blurb.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{blurb.text}</p>
        <div className="mt-3">
          <SignatureBox cta={blurb.cta} />
        </div>
      </section>

      {elsewhere.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Code {error.code} means something else in other programs
          </h2>
          <p className="mt-1 text-xs text-neutral-500">
            Custom codes are private to each program. Check which program actually raised it: it is the innermost
            failed call, not necessarily the program you called.
          </p>
          <ul className="mt-2 divide-y divide-neutral-200 dark:divide-neutral-800">
            {elsewhere.slice(0, 12).map((o) => (
              <li key={o.program.slug}>
                <Link href={`/errors/${o.program.slug}/${o.error.code}`} className="flex justify-between gap-4 py-2 text-sm hover:text-emerald-600 dark:hover:text-emerald-400">
                  <span className="truncate font-semibold">{o.error.name}</span>
                  <span className="shrink-0 text-neutral-500">{o.program.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className="mt-10 flex justify-between gap-4 text-sm text-neutral-500">
        {previous ? (
          <Link href={`/errors/${program.slug}/${previous.code}`} className="truncate hover:text-emerald-500">
            ← {previous.code} {previous.name}
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/errors/${program.slug}/${next.code}`} className="truncate text-right hover:text-emerald-500">
            {next.code} {next.name} →
          </Link>
        )}
      </nav>
    </main>
  );
}
