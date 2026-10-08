import type { Metadata } from "next";
import { SiteHeader } from "@/components/SiteHeader";
import { readFailureIndex, readStats } from "@/lib/stats";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Every claim, one click | TxWhy",
  description: "Everything TxWhy claims, with the link that checks it: on-chain receipts, the public failure index, live usage, the test suites, the packages and the tester log.",
};

const n = (v: number | undefined | null) => (v == null ? "…" : v.toLocaleString("en-US"));
const pct = (v: number | undefined | null) => (v == null ? "…" : `${(v * 100).toFixed(1)}%`);

interface Claim {
  claim: string;
  check: string;
  href: string;
  live?: string;
}

/**
 * Judges and reviewers have minutes. This page is the whole submission as a checklist: every
 * sentence we say about TxWhy, next to the one link that proves or disproves it.
 */
export default async function ProofPage() {
  const [stats, index] = await Promise.all([readStats(), readFailureIndex()]);
  const rebuilt = index?.repair?.verdicts?.repaired;
  const people = index?.repair?.segments?.rebuiltShareOfPeople;

  const groups: { title: string; items: Claim[] }[] = [
    {
      title: "It works on mainnet",
      items: [
        {
          claim: "A real agent swap built on a stale quote failed simulation, was rebuilt from a fresh quote for the same trade, verified locally, and landed.",
          check: "Solscan, Sep 23, slot 449732359",
          href: "https://solscan.io/tx/5BaKDPgC4tK3prhiLGKFgHkcWTcvNGDBAjoBNiw9dTjx9o9v7DoX1qTwbks4W9uZPJKszju3MMMcoB5XZ6zXhymq",
        },
        {
          claim: "An agent paid $0.001 USDC for a verified repair over x402 on mainnet, with no account.",
          check: "Solscan receipt",
          href: "https://solscan.io/tx/2t4hz3zmmBkAtVyNaMY48ot9uhP7uLLLogdq23PtzScHKmeTA276Gt8Y1uyyeDpNsUciaPhDzMiCQcPA9AcAUzrA",
        },
        {
          claim: "The paid endpoint is listed in the x402 Bazaar, the facilitator's public catalog.",
          check: "PayAI discovery (search TxWhy)",
          href: "https://facilitator.payai.network/discovery/resources",
        },
        {
          claim: "Run a repair on live mainnet state right now, no wallet needed.",
          check: "/repair, four one-click demos",
          href: "/repair",
        },
      ],
    },
    {
      title: "It is measured, not claimed",
      items: [
        {
          claim: "The worker samples nine of Solana's busiest programs around the clock and replays real landed failures through the engine every 90 seconds, publishing every verdict with its exact reason.",
          check: "/failures",
          href: "/failures",
          live: index ? `${n(index.transactionsSeen)} sampled since Sep 21, ${pct(index.failureRate)} failed, ${n(index.repair?.attempted)} replayed, ${n(rebuilt)} rebuilt and verified${people != null ? `, ${pct(people)} of the failures real people hit` : ""}` : undefined,
        },
        {
          claim: "The same index as JSON, free to reuse, CC BY 4.0, no addresses stored.",
          check: "/api/v1/index",
          href: "/api/v1/index",
        },
        {
          claim: "Usage is counted by the service itself, with tests excluded, and published.",
          check: "/stats",
          href: "/stats",
          live: stats ? `${n(stats.repairs)} repairs for ${n(stats.callers)} distinct callers, ${n(stats.diagnoses)} diagnoses` : undefined,
        },
      ],
    },
    {
      title: "You never have to trust it",
      items: [
        {
          claim: "The rule for what a repair may change is code you run yourself, with no network access: same fee payer, same signers, every other instruction byte for byte, one swap replaced or one limit moved within the cap.",
          check: "src/lib/verify.ts",
          href: "https://github.com/SUNDRAM07/txwhy/blob/main/src/lib/verify.ts",
        },
        {
          claim: "The verifier exists in TypeScript, Rust and Python, all tested against the same real-repair fixtures and 48 attack cases, on every push.",
          check: "GitHub Actions, CI on main",
          href: "https://github.com/SUNDRAM07/txwhy/actions/workflows/ci.yml",
        },
        {
          claim: "The server runs the verifier on its own output and refuses to return a repair that fails it; a repaired transaction is only returned after it passes simulation.",
          check: "src/lib/repair.ts",
          href: "https://github.com/SUNDRAM07/txwhy/blob/main/src/lib/repair.ts",
        },
        {
          claim: "Hardened like infrastructure: 122 malformed inputs against the repair API and 52 against the MCP server, never a 500.",
          check: "scripts/fuzz-repair.mjs and scripts/fuzz-mcp.mjs",
          href: "https://github.com/SUNDRAM07/txwhy/tree/main/scripts",
        },
      ],
    },
    {
      title: "Someone else has used it",
      items: [
        {
          claim: "An external builder ran his own failed swaps through the CLI over four rounds, Oct 4 to 7, and every point he raised shipped the same day. Quoted with permission.",
          check: "TESTERS.md",
          href: "https://github.com/SUNDRAM07/txwhy/blob/main/TESTERS.md",
        },
        {
          claim: "Solana Agent Kit, the default agent toolkit, has no repair step; our pull request adds one.",
          check: "sendaifun/solana-agent-kit#620",
          href: "https://github.com/sendaifun/solana-agent-kit/pull/620",
        },
      ],
    },
    {
      title: "It ships in every stack",
      items: [
        { claim: "npm: @txwhy/sdk, with sendWithRepair for web3.js and @solana/kit, a one-line wallet wrapper for any dApp, and the npx txwhy command line.", check: "npmjs.com", href: "https://www.npmjs.com/package/@txwhy/sdk" },
        { claim: "PyPI: txwhy, the same verifier and send loop for solana-py.", check: "pypi.org", href: "https://pypi.org/project/txwhy/" },
        { claim: "crates.io: txwhy-verify, the offline verifier in Rust.", check: "crates.io", href: "https://crates.io/crates/txwhy-verify" },
        { claim: "MCP server with three tools for any agent, streamable HTTP.", check: "/api/mcp", href: "https://txwhy.vercel.app/api/mcp" },
        { claim: "Telegram bot with wallet failure alerts.", check: "@txwhy_bot", href: "https://t.me/txwhy_bot" },
        { claim: "Browser extension that adds the missing paragraph on Solscan and Solana Explorer.", check: "extension/", href: "https://github.com/SUNDRAM07/txwhy/tree/main/extension" },
        { claim: "573 error-code pages, so a search for 0x1771 lands on an answer.", check: "/errors", href: "/errors" },
        { claim: "MIT, one repository, every commit in the open.", check: "github.com/SUNDRAM07/txwhy", href: "https://github.com/SUNDRAM07/txwhy" },
      ],
    },
  ];

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
      <SiteHeader />
      <header className="mt-10">
        <h1 className="text-3xl font-bold tracking-tight">Every claim, one click</h1>
        <p className="mt-3 text-neutral-600 dark:text-neutral-400">
          Everything we say about TxWhy, next to the link that checks it. Numbers marked live come from the service itself as this page is rendered.
        </p>
      </header>
      {groups.map((g) => (
        <section key={g.title} className="mt-10">
          <h2 className="text-lg font-semibold">{g.title}</h2>
          <ol className="mt-3 divide-y divide-neutral-200 rounded-xl border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {g.items.map((item) => (
              <li key={item.href + item.claim} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-start">
                <div>
                  <p className="text-sm">{item.claim}</p>
                  {item.live && (
                    <p className="mt-1 text-xs text-emerald-700 tabular-nums dark:text-emerald-400">
                      <span className="font-semibold uppercase tracking-wide">live</span> {item.live}
                    </p>
                  )}
                </div>
                <a
                  href={item.href}
                  target={item.href.startsWith("/") ? undefined : "_blank"}
                  rel={item.href.startsWith("/") ? undefined : "noreferrer"}
                  className="inline-flex min-h-10 items-center rounded-lg border border-neutral-300 px-3 text-xs font-medium whitespace-nowrap transition-colors hover:border-emerald-500 hover:text-emerald-600 focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:border-neutral-700 dark:hover:text-emerald-400"
                >
                  {item.check}
                </a>
              </li>
            ))}
          </ol>
        </section>
      ))}
      <p className="mt-10 text-xs text-neutral-500">
        Something here that does not check out? Open an issue at github.com/SUNDRAM07/txwhy. The claim comes down before the page does.
      </p>
    </main>
  );
}
