"use client";

/* ─────────────────────────────────────────────────────────
 * HOME STORYBOARD
 *
 * The header, headline, input and Diagnose button are static:
 * visible and usable at 0 ms. On first paint:
 *
 *    0 ms   headline words rise in, 40 ms apart (once)
 *  300 ms+  RepairReplay plays one real repair, line by line
 *  index    LiveProof numbers count up when the index answers
 *
 * Below the fold each section reveals once, 10 px and 350 ms,
 * as it enters the viewport; inside them the pipeline pulses
 * once and the failure bars grow once. Everything else moves
 * only when you touch it. Reduced motion: finished states only.
 * ───────────────────────────────────────────────────────── */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { extractSignature } from "@/lib/trace";
import { BeforeAfter } from "@/components/BeforeAfter";
import { CodeTabs } from "@/components/CodeTabs";
import { FailureBars } from "@/components/FailureBars";
import { LiveProof } from "@/components/LiveProof";
import { Pipeline } from "@/components/Pipeline";
import { RepairReplay } from "@/components/RepairReplay";
import { Reveal } from "@/components/Reveal";
import { SiteHeader } from "@/components/SiteHeader";
import usedBy from "@/lib/data/used-by.json";

/** Projects with TxWhy in their send loop. Edit src/lib/data/used-by.json; the section hides while empty. */
const USED_BY = usedBy as { name: string; url: string; how: string; quote?: string }[];

const EXAMPLES = [
  { label: "Arbitrage bot that missed its price gap", signature: "4UBhmyAASkEzCNFxHB34zDUyi8AoGy289egTkitEx9P48zGNqkwjr8scNpHUvFYwaQ83dkiD5wTMGUqF5BUMGRp8" },
  { label: "Raydium swap that hit an overflow", signature: "3pJdqu5pahcNn9zyqk888f9khh12TgfPW8jzfe9p2ARfVFHbXSrH3Jjw1ihnUvs79gkzmoaV981Wb2fHip3PEGJn" },
];

const FIXES: { failure: string; action: string }[] = [
  { failure: "Blockhash expired", action: "Replaced with a current one, after checking the original had really expired." },
  { failure: "Compute budget exceeded", action: "Run at the maximum budget, read what it truly used, set the limit to that plus headroom." },
  { failure: "Dropped under load", action: "Priority fee set from what the network recently charged for the exact accounts you write to, capped at 0.001 SOL." },
  { failure: "Loaded account data limit too small", action: "Lifted when the transaction declares less than it actually loads." },
  { failure: "Slippage on a Jupiter swap", action: "Only the swap instruction is replaced with a fresh quote for the same tokens, amount and tolerance. Refused above 3% price impact." },
  { failure: "Slippage on a direct Pump.fun, PumpSwap, Raydium or Meteora swap", action: "Amount and accounts stay as written. Only the limit moves to the price the chain itself computed, never more than 25% against you." },
  { failure: "Version 1 transactions", action: "Solana's new format since Sep 15, 2026. Read and rebuilt natively, including the compute settings in the header." },
];

const EXPLAINS: { failure: string; action: string }[] = [
  { failure: "Your wallet's safety guard tripped", action: "A Lighthouse assertion shares the number 0x1771 with Jupiter's slippage error, so explorers call it slippage. TxWhy decodes the guard and names the exact requirement that failed." },
  { failure: "Not enough SOL, or not enough tokens to sell", action: "The exact shortfall: what the account holds, what the swap needs, in SOL or in the token's units." },
  { failure: "A program rejected it", action: "The named cause and fix from the program's own published errors, where they exist." },
];

const CURL = `curl -X POST https://txwhy.vercel.app/api/v1/repair \\
  -H "content-type: application/json" \\
  -d '{"transaction": "<base64, signed or unsigned>"}'`;

const MCP_CONFIG = `{
  "mcpServers": {
    "txwhy": { "url": "https://txwhy.vercel.app/api/mcp" }
  }
}`;

const RESPONSE = `{
  "status": "repaired",
  "cause": { "title": "Compute budget exceeded", ... },
  "changes": [
    { "type": "compute_unit_limit", "before": "100", "after": "518", "reason": "..." }
  ],
  "repairedTransaction": "<base64, unsigned>",
  "simulation": { "passed": true, "unitsConsumed": 450 },
  "verification": { "ok": true, "kept": 3 }
}`;

const LANGUAGES = [
  {
    id: "ts",
    label: "TypeScript",
    install: "npm i @txwhy/sdk",
    code: `import { sendWithRepair } from "@txwhy/sdk";

// simulate -> repair if it would fail -> verify locally -> sign -> send
const { signature, repairs } = await sendWithRepair(
  connection,
  transaction,
  (tx) => wallet.signTransaction(tx),   // your keys never leave your process
);`,
  },
  {
    id: "wallet",
    label: "Any dApp",
    install: "npm i @txwhy/sdk",
    code: `import { withRepair } from "@txwhy/sdk/wallet";

// Phantom, Solflare, Backpack: anything that can sign. One prompt, for the tx that lands.
const { connection } = useConnection();
const wallet = useWallet();
const { signature, repairs } = await withRepair(wallet, connection).sendTransaction(tx);`,
  },
  {
    id: "py",
    label: "Python",
    install: 'pip install "txwhy[solana]"',
    code: `from txwhy.solana import async_send_with_repair

# simulate -> repair if it would fail -> verify locally -> sign -> send
signature = await async_send_with_repair(client, tx, keypair)`,
  },
  {
    id: "rs",
    label: "Rust",
    install: "cargo add txwhy-verify",
    code: `use txwhy_verify::verify_instructions;

// prove, offline, that the repair changed only what a repair may change
let check = verify_instructions(&payer, &original, &payer, &repaired);
assert!(check.ok, "{:?}", check.violations);   // never sign otherwise`,
  },
];

const VERIFY = `import { verifyRepair } from "@txwhy/sdk";

const check = await verifyRepair(connection, original, repaired);   // no network call
if (!check.ok) throw new Error(check.violations.join(" "));          // never sign it`;

const HEADLINE = ["Failed", "transaction", "in."];
const HEADLINE_2 = ["Working", "transaction", "out."];

const link = "rounded text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:outline-none dark:text-emerald-400";
const code = "rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[0.9em] dark:bg-neutral-900";
const section = "border-t border-neutral-200 py-16 dark:border-neutral-800";
const muted = "text-neutral-600 dark:text-neutral-400";
const card = "rounded-xl border border-neutral-200 bg-white/60 p-5 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-emerald-500/50 dark:border-neutral-800 dark:bg-neutral-900/40";
const eyebrow = "text-xs font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-400";

function Words({ words, offset, accent }: { words: string[]; offset: number; accent?: boolean }) {
  const reduced = useReducedMotion();
  return (
    <span className={accent ? "text-emerald-500" : undefined}>
      {words.map((w, i) => (
        <motion.span
          key={w}
          className="inline-block"
          initial={reduced ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 26, delay: reduced ? 0 : (offset + i) * 0.045 }}
        >
          {w}
          {i < words.length - 1 ? " " : ""}
        </motion.span>
      ))}
    </span>
  );
}

export default function Home() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const sig = extractSignature(input);
    if (!sig) {
      setError("That doesn't look like a transaction signature or explorer link.");
      return;
    }
    setError(null);
    setLoading(true);
    router.push(`/tx/${sig}`);
  }

  return (
    <main className="relative mx-auto w-full min-w-0 max-w-5xl px-4 pb-24 sm:px-6">
      <div className="hero-backdrop pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46rem]" aria-hidden />
      <SiteHeader />

      {/* Hero: static on the left, one replay on the right. */}
      <section className="grid items-center gap-10 pt-14 pb-6 lg:grid-cols-[1.05fr_0.95fr] lg:pt-20">
        <div className="text-center lg:text-left">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            <Words words={HEADLINE} offset={0} />
            <br />
            <Words words={HEADLINE_2} offset={3} accent />
          </h1>
          <p className={`mx-auto mt-5 max-w-xl text-lg leading-relaxed lg:mx-0 ${muted}`}>
            TxWhy finds the exact reason a Solana transaction failed, rebuilds it, and proves the rebuilt one works by
            simulating it against live chain state. For people, bots and AI agents.
          </p>

          <form onSubmit={submit} className="mx-auto mt-8 max-w-xl lg:mx-0">
            <label htmlFor="signature" className="sr-only">
              Transaction signature or explorer URL
            </label>
            <div className="flex w-full gap-2">
              <input
                id="signature"
                name="signature"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Transaction signature or explorer URL"
                spellCheck={false}
                autoComplete="off"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-3 font-mono text-sm outline-none transition-colors duration-100 focus:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:border-neutral-700 dark:bg-neutral-900"
              />
              <button
                type="submit"
                disabled={loading}
                aria-busy={loading}
                className="min-h-11 rounded-lg bg-emerald-600 px-5 py-3 font-medium text-white transition-[background-color,transform] duration-100 hover:bg-emerald-500 active:translate-y-px focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50 dark:focus-visible:ring-offset-neutral-950"
              >
                {loading ? "Tracing…" : "Diagnose"}
              </button>
            </div>
            {error && (
              <p className="mt-2 text-left text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
          </form>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm lg:justify-start">
            <span className={muted}>Try one:</span>
            {EXAMPLES.map((ex) => (
              <Link key={ex.signature} href={`/tx/${ex.signature}`} className={link}>
                {ex.label}
              </Link>
            ))}
          </div>
          <p className="mt-3 text-sm">
            <Link href="/repair" className={link}>
              Not sent yet? Repair it before you send →
            </Link>
          </p>
        </div>

        <RepairReplay />
      </section>

      <LiveProof />

      <Reveal>
        <section className={`${section} mt-8`}>
          <div className="grid gap-8 md:grid-cols-[1fr_1.4fr]">
            <div>
              <p className={eyebrow}>Why this exists</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight">Every tool explains the failure. None of them fixes it.</h2>
            </div>
            <p className={`leading-relaxed ${muted}`}>
              On a busy day somewhere between one in eight and one in two Solana transactions fail. Bots and agents fail
              more than half of what they send, and the priority fee is burned every time. What they get back is a code
              like <code className={code}>Custom(6001)</code>. Explorers and AI explainers tell you what happened. TxWhy
              hands you the transaction that works, and proves it.
            </p>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className={section}>
          <p className={eyebrow}>Before and after</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">What your bot sees today, and what it gets back from TxWhy</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>The same failed Jupiter swap, both ways. Switch between them.</p>
          <div className="mt-5">
            <BeforeAfter />
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section id="how" className={section}>
          <p className={eyebrow}>How it works</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Six stages, about a second, one rule at the end</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            Pick a stage to see what it does and, just as important, what it refuses to do. The last stage runs on your
            machine, not ours.
          </p>
          <div className="mt-6">
            <Pipeline />
          </div>
          <p className={`mt-4 text-sm ${muted}`}>
            The rebuilt transaction comes back unsigned. You sign it with your own wallet. TxWhy never sees a key.
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section id="live" className={section}>
          <div className="grid gap-10 md:grid-cols-[1fr_1.2fr]">
            <div>
              <p className={eyebrow}>Right now on mainnet</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight">What is failing, measured every 90 seconds</h2>
              <p className={`mt-3 leading-relaxed ${muted}`}>
                A worker samples the nine busiest programs around the clock, classifies each failure with the same engine
                you get, and replays a slice through the repair path. The numbers on this page are read from it, not
                typed in.
              </p>
            </div>
            <FailureBars />
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section className={section}>
          <p className={eyebrow}>Coverage</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">What it handles today</h2>
          <div className="mt-6 grid gap-8 md:grid-cols-2">
            <div>
              <p className="inline-block rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">Fixes</p>
              <ul className="mt-3 grid gap-3">
                {FIXES.map((f) => (
                  <li key={f.failure} className={card}>
                    <p className="font-medium">{f.failure}</p>
                    <p className={`mt-0.5 text-sm leading-relaxed ${muted}`}>{f.action}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="inline-block rounded-full bg-neutral-500/15 px-2.5 py-0.5 text-xs font-semibold text-neutral-700 dark:text-neutral-300">Explains, and says so</p>
              <ul className="mt-3 grid gap-3">
                {EXPLAINS.map((f) => (
                  <li key={f.failure} className={card}>
                    <p className="font-medium">{f.failure}</p>
                    <p className={`mt-0.5 text-sm leading-relaxed ${muted}`}>{f.action}</p>
                  </li>
                ))}
              </ul>
              <p className={`mt-4 text-sm leading-relaxed ${muted}`}>
                When a rebuild cannot fix it, TxWhy says so, with the exact reason. It never hands back a transaction
                that would fail again, and it refuses a repair you should not sign: a thin route, a price that moved too
                far.
              </p>
            </div>
          </div>
        </section>
      </Reveal>

      <Reveal>
        <section id="sdk" className={section}>
          <p className={eyebrow}>Integrate</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">One line in your send loop. Three languages, one rule.</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            Most failures happen at simulation, before anything is sent, so that is where the repair belongs. If your
            transaction passes, it is signed and sent and TxWhy is never contacted. If it would fail, it comes back
            rebuilt, is checked on your machine, and only then reaches your signer.
          </p>
          <div className="mt-5">
            <CodeTabs tabs={LANGUAGES} />
          </div>
          <p className={`mt-3 text-sm ${muted}`}>
            From a terminal: <code className={code}>npx @txwhy/sdk &lt;signature&gt;</code>. On @solana/kit, including
            version 1 transactions: <code className={code}>import {"{ sendWithRepair }"} from &quot;@txwhy/sdk/kit&quot;</code>.
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section id="tested" className={section}>
          <p className={eyebrow}>Validation</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Tested by builders, fixed the same day</h2>
          <figure className={`mt-6 ${card}`}>
            <blockquote className="space-y-3 text-[15px] leading-relaxed">
              <p>
                &ldquo;Explanation 3 of 3 correct, would sign 0 of 3 as presented. The CLI output itself is excellent
                (blockhash/quote/CU diff, &lsquo;nothing else was touched&rsquo;).&rdquo;
              </p>
              <p className={muted}>
                Four days and four rounds later: &ldquo;A hard 3% impact cap and a NO REPAIR headline is exactly what
                I&rsquo;d want as a signer. Four rounds, every point fixed the same day.&rdquo;
              </p>
            </blockquote>
            <figcaption className={`mt-4 text-sm ${muted}`}>
              Godswill, builder of{" "}
              <a href="https://vouchhq.vercel.app" target="_blank" rel="noreferrer" className={link}>
                Vouch
              </a>
              , after running his own failed Jupiter swaps through the CLI, Oct 4 to 7, 2026.
            </figcaption>
          </figure>
          <p className={`mt-4 text-sm ${muted}`}>
            What he found and what changed, round by round, is in{" "}
            <a href="https://github.com/SUNDRAM07/txwhy/blob/main/TESTERS.md" className={link}>
              TESTERS.md
            </a>
            . Run one of your own failed signatures and tell me what is wrong with the answer.
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section id="explorer" className={section}>
          <p className={eyebrow}>In the explorer</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Where you actually land when something fails</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            The first thing anyone opens is the explorer page, and the explorer stops at{" "}
            <code className={code}>custom program error: 0x1771</code>. The TxWhy browser extension adds the missing
            paragraph on Solscan, Solana Explorer, SolanaFM and Orb: the failing instruction, the cause in plain words, what
            to do, and whether a rebuilt version passes right now. It reads only the signature from the URL and talks only
            to this site.
          </p>
          <div className="mt-5 overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800">
            <div className="flex items-center gap-1.5 border-b border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900" aria-hidden>
              <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
              <span className="h-2.5 w-2.5 rounded-full bg-neutral-300 dark:bg-neutral-700" />
              <span className="ml-3 rounded bg-white px-2 py-0.5 font-mono text-[11px] text-neutral-500 dark:bg-neutral-950">explorer.solana.com/tx/…</span>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/extension-explorer.png"
              alt="The TxWhy panel on a failed transaction in Solana Explorer, explaining a tripped Lighthouse guard"
              width={1600}
              height={900}
              className="w-full"
            />
          </div>
          <p className={`mt-3 text-sm ${muted}`}>
            Free and open source, in{" "}
            <a href="https://github.com/SUNDRAM07/txwhy/tree/main/extension" className={link}>
              extension/
            </a>{" "}
            in the repo. Load it unpacked from chrome://extensions until it is on the Web Store.
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section id="proof" className={section}>
          <p className={eyebrow}>Proof, on chain</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Two transactions on mainnet you can open yourself</h2>
          <p className={`mt-2 ${muted}`}>
            Every other claim on this site, next to the one link that checks it:{" "}
            <Link href="/proof" className={link}>
              txwhy.vercel.app/proof
            </Link>
          </p>
          <ul className="mt-5 grid gap-4 text-sm leading-relaxed sm:grid-cols-2">
            <li className={card}>
              <p className="font-semibold">A repaired transaction that landed</p>
              <p className={`mt-1 ${muted}`}>
                An agent built a swap on a stale quote. Without TxWhy it failed simulation with{" "}
                <code className={code}>0x1771</code>. With one line, it was rebuilt from a fresh quote for the same trade,
                verified locally, signed by the agent, and landed in slot 449,732,359.
              </p>
              <a href="https://solscan.io/tx/5BaKDPgC4tK3prhiLGKFgHkcWTcvNGDBAjoBNiw9dTjx9o9v7DoX1qTwbks4W9uZPJKszju3MMMcoB5XZ6zXhymq" target="_blank" rel="noreferrer" className={`mt-3 inline-block break-all font-mono text-xs ${link}`}>
                5BaKDPgC…zXhymq on Solscan →
              </a>
            </li>
            <li className={card}>
              <p className="font-semibold">An agent that paid for a repair</p>
              <p className={`mt-1 ${muted}`}>
                $0.001 in USDC over x402 for a verified slippage repair, settled only after the answer came back, network
                fee paid by the facilitator. No account, no API key.
              </p>
              <a href="https://solscan.io/tx/2t4hz3zmmBkAtVyNaMY48ot9uhP7uLLLogdq23PtzScHKmeTA276Gt8Y1uyyeDpNsUciaPhDzMiCQcPA9AcAUzrA" target="_blank" rel="noreferrer" className={`mt-3 inline-block break-all font-mono text-xs ${link}`}>
                2t4hz3zm…AcAUzrA on Solscan →
              </a>
            </li>
          </ul>
        </section>
      </Reveal>

      {USED_BY.length > 0 && (
        <Reveal>
          <section id="used-by" className={section}>
            <h2 className="text-2xl font-bold tracking-tight">Used by</h2>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {USED_BY.map((u) => (
                <li key={u.name} className={card}>
                  <a href={u.url} target="_blank" rel="noreferrer" className="font-semibold hover:text-emerald-500">
                    {u.name}
                  </a>
                  <span className={`ml-2 text-xs ${muted}`}>{u.how}</span>
                  {u.quote && <p className={`mt-2 text-sm leading-relaxed ${muted}`}>&ldquo;{u.quote}&rdquo;</p>}
                </li>
              ))}
            </ul>
          </section>
        </Reveal>
      )}

      <Reveal>
        <section id="verify" className={section}>
          <p className={eyebrow}>Trust</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">You never have to trust us</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            Signing a transaction that a server rebuilt should make you nervous. So every repair comes with a proof, and
            the check behind it is open source, has no network access, and runs on your machine, in TypeScript, Rust or
            Python. A repaired transaction may differ from yours only in these ways:
          </p>
          <ul className={`mt-3 max-w-prose list-disc space-y-1.5 pl-5 text-sm leading-relaxed ${muted}`}>
            <li>compute budget settings: limit, priority fee, loaded data size</li>
            <li>the recent blockhash</li>
            <li>
              one Jupiter swap replaced by another for the same wallet, the same source and destination token accounts,
              the same output token, the same amount, the same slippage tolerance, and a quote no more than 25% worse
            </li>
            <li>one direct swap with only its limit moved, never more than 25% against you</li>
            <li>a SOL wrap into that swap&rsquo;s own input account raised by no more than the maximum rose</li>
          </ul>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            Same fee payer, same signers, every other instruction byte for byte and in the same order. Anything else is
            refused. The test suite attacks the rule 48 ways: an extra transfer, a redirected fee, a new signer, a widened
            slippage, proceeds sent to a stranger, a quote 26% worse. All are caught, and the three verifiers are tested
            against the same real-repair fixtures. TxWhy runs the same check on its own output and will not return a
            transaction that fails it.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">{VERIFY}</pre>
        </section>
      </Reveal>

      <Reveal>
        <section id="pricing" className={section}>
          <p className={eyebrow}>Pricing</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">Free for people. A tenth of a cent for agents.</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            The website, the bot and <code className={code}>/api/v1/repair</code> are free and rate limited. Agents that
            need guaranteed capacity call <code className={code}>/api/x402/repair</code> instead: $0.001 in USDC per repair
            over x402, no account, no API key, charged only when the answer succeeds. A repaired transaction that lands
            costs less than the priority fee on one that does not.
          </p>
        </section>
      </Reveal>

      <Reveal>
        <section id="api" className={section}>
          <p className={eyebrow}>API and MCP</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight">For agents and bots</h2>
          <p className={`mt-3 max-w-prose leading-relaxed ${muted}`}>
            One call inside your send loop. When your RPC rejects a transaction at simulation, pass it here and get back a
            version that passes, typically in under a second. Most failures never reach the chain. They happen at this
            step, and this is where TxWhy sits.
          </p>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <pre className="overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">{CURL}</pre>
            <pre className={`overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800 ${muted}`}>{RESPONSE}</pre>
          </div>
          <h3 className="mt-8 font-semibold">Or plug it into any agent as a tool</h3>
          <p className={`mt-2 max-w-prose text-sm leading-relaxed ${muted}`}>
            TxWhy is an MCP server. Add the URL and your agent gets three tools: <code className="font-mono">repair_transaction</code>,{" "}
            <code className="font-mono">diagnose_transaction</code> and <code className="font-mono">explain_error</code>. No key,
            no account.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">{MCP_CONFIG}</pre>
          <p className={`mt-3 max-w-prose text-sm leading-relaxed ${muted}`}>
            You can also pass <code className={code}>{`{"signature": "..."}`}</code> for a transaction that already landed
            and failed. Status is one of <code className="font-mono">repaired</code>, <code className="font-mono">valid</code>,{" "}
            <code className="font-mono">needs_requote</code> or <code className="font-mono">not_repairable</code>.
          </p>
        </section>
      </Reveal>

      <footer className={`flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-8 text-sm dark:border-neutral-800 ${muted}`}>
        <span>Built for Solana. Entered in Colosseum&apos;s Crypto World&apos;s Fair.</span>
        <span className="flex gap-4">
          <a href="https://github.com/SUNDRAM07/txwhy" className={link}>GitHub</a>
          <a href="https://www.npmjs.com/package/@txwhy/sdk" className={link}>npm</a>
          <a href="https://pypi.org/project/txwhy/" className={link}>PyPI</a>
          <a href="https://crates.io/crates/txwhy-verify" className={link}>crates.io</a>
          <a href="https://t.me/txwhy_bot" className={link}>Telegram</a>
        </span>
      </footer>
    </main>
  );
}
