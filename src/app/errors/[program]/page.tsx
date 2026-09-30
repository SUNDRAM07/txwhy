import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { SiteHeader } from "@/components/SiteHeader";
import { getProgram, listPrograms } from "@/lib/catalog";

export function generateStaticParams() {
  return listPrograms().map((p) => ({ program: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ program: string }> }): Promise<Metadata> {
  const program = getProgram((await params).program);
  if (!program) return { title: "Unknown program | TxWhy" };
  return {
    title: `${program.name} error codes (${program.errors.length}) | TxWhy`,
    description: `${program.blurb} Decimal and hex, for example ${program.errors[0]?.code} (${program.errors[0]?.hex}) ${program.errors[0]?.name}.`,
  };
}

export default async function ProgramErrorsPage({ params }: { params: Promise<{ program: string }> }) {
  const slug = (await params).program;
  // People land here with the bare code from an error message: /errors/0x1771 or /errors/6001.
  if (/^0x[0-9a-f]+$/i.test(slug)) permanentRedirect(`/errors/code/${slug.toLowerCase()}`);
  if (/^\d+$/.test(slug)) permanentRedirect(`/errors/code/0x${Number(slug).toString(16)}`);
  const program = getProgram(slug);
  if (!program) notFound();

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl px-4 py-10">
      <SiteHeader />

      <p className="mt-8 text-sm text-neutral-500">
        <Link href="/errors" className="hover:text-emerald-500">
          Error codes
        </Link>{" "}
        / {program.name}
      </p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">{program.name} error codes</h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-500">{program.blurb}</p>
      {program.address && <p className="mt-2 font-mono text-xs break-all text-neutral-500">{program.address}</p>}

      <ul className="mt-6 divide-y divide-neutral-200 dark:divide-neutral-800">
        {program.errors.map((e) => (
          <li key={e.code}>
            <Link href={`/errors/${program.slug}/${e.code}`} className="block py-3 hover:text-emerald-600 dark:hover:text-emerald-400">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-xs text-neutral-500">
                  {e.code} · {e.hex}
                </span>
                <span className="font-semibold">{e.name}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-sm text-neutral-500">{e.cause}</p>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
