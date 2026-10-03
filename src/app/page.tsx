"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { extractSignature } from "@/lib/trace";
import usedBy from "@/lib/data/used-by.json";

/** Projects with TxWhy in their send loop. Edit src/lib/data/used-by.json; the section hides while empty. */
const USED_BY = usedBy as { name: string; url: string; how: string; quote?: string }[];

const EXAMPLES = [
  {
    label: "Arbitrage bot that missed its price gap",
    signature:
      "4UBhmyAASkEzCNFxHB34zDUyi8AoGy289egTkitEx9P48zGNqkwjr8scNpHUvFYwaQ83dkiD5wTMGUqF5BUMGRp8",
  },
  {
    label: "Raydium swap that hit an overflow",
    signature:
      "3pJdqu5pahcNn9zyqk888f9khh12TgfPW8jzfe9p2ARfVFHbXSrH3Jjw1ihnUvs79gkzmoaV981Wb2fHip3PEGJn",
  },
];

const FIXES: { failure: string; action: string; fixed: boolean }[] = [
  {
    failure: "Blockhash expired",
    action: "Replaced with a current one. We check whether the original had really expired.",
    fixed: true,
  },
  {
    failure: "Compute budget exceeded",
    action: "We run the transaction with the maximum budget, read what it truly used, and set the limit to that plus headroom.",
    fixed: true,
  },
  {
    failure: "Dropped under load",
    action: "Priority fee set from what the network recently charged for the exact accounts you write to.",
    fixed: true,
  },
  {
    failure: "Slippage on a Jupiter swap",
    action: "Only the swap instruction is replaced with a freshly quoted one. Your tokens, amount, tolerance and every other instruction stay exactly as written, and we show how the minimum you receive changed.",
    fixed: true,
  },
  {
    failure: "Loaded account data limit too small",
    action: "Lifted when the transaction declares a limit smaller than what it actually loads.",
    fixed: true,
  },
  {
    failure: "Slippage on a direct Pump.fun, PumpSwap, Raydium or Meteora swap",
    action: "These instructions carry no tolerance, only a limit. The amount and every account stay as written; only the limit moves to the price the program itself computed, read from its failed check or from a simulation of the same transaction with the limit lifted, with a stated 1% tolerance and never more than 25% against you.",
    fixed: true,
  },
  {
    failure: "Version 1 transactions (half of Jupiter traffic two weeks after activation)",
    action: "SIMD-0385 went live on mainnet on Sep 15, 2026 and moved compute settings into the transaction header. TxWhy reads and rebuilds v1 natively: the same repairs, applied to the header, re-encoded with @solana/kit.",
    fixed: true,
  },
  {
    failure: "Your wallet's safety guard tripped",
    action:
      "Wallets and trading apps append a Lighthouse assertion that aborts the transaction if state changed since preview. Its error shares the number 0x1771 with Jupiter's slippage error, so explorers call it slippage. TxWhy decodes the guard itself: which account, which value, what it required, and that nothing was swapped.",
    fixed: false,
  },
  {
    failure: "Not enough SOL",
    action: "Not something a rebuild can fix. We give you the exact shortfall instead.",
    fixed: false,
  },
  {
    failure: "A program rejected it",
    action: "Named cause and fix from the program's own published errors, where they exist.",
    fixed: false,
  },
];

const CURL = `curl -X POST https://txwhy.vercel.app/api/v1/repair \\
  -H "content-type: application/json" \\
  -d '{"transaction": "<base64, signed or unsigned>"}'`;

const MCP_CONFIG = `{
  "mcpServers": {
    "txwhy": { "url": "https://txwhy.vercel.app/api/mcp" }
  }
}`;

/** Flip once the "@txwhy/sdk" package is live on npm. Until then the name is never shown, so nobody can squat it. */
const SDK_PUBLISHED = true;
/** Flip once X402_PAY_TO is set on the deployment. */
const X402_LIVE = true;

const SDK = `import { sendWithRepair } from "@txwhy/sdk";

// simulate -> repair if it would fail -> verify locally -> sign -> send
const { signature, repairs } = await sendWithRepair(
  connection,
  transaction,
  (tx) => wallet.signTransaction(tx),   // your keys never leave your process
);`;

const VERIFY = `import { verifyRepair } from "@txwhy/sdk";

const check = await verifyRepair(connection, original, repaired);
if (!check.ok) throw new Error(check.violations.join(" "));  // never sign it`;

const RESPONSE = `{
  "status": "repaired",
  "cause": { "title": "Compute budget exceeded", ... },
  "changes": [
    { "type": "compute_unit_limit", "before": "100", "after": "518" }
  ],
  "repairedTransaction": "<base64, unsigned>",
  "simulation": { "passed": true, "unitsConsumed": 450 }
}`;

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
    <main className="mx-auto w-full min-w-0 max-w-3xl px-4 pb-24">
      <header className="flex items-center justify-between gap-4 py-6">
        <span className="font-bold tracking-tight">
          Tx<span className="text-emerald-500">Why</span>
        </span>
        <nav className="flex min-w-0 gap-4 overflow-x-auto text-sm whitespace-nowrap text-neutral-500 sm:gap-5">
          <Link href="/repair" className="hover:text-emerald-500">
            Repair
          </Link>
          <Link href="/errors" className="hover:text-emerald-500">
            Error codes
          </Link>
          <a href="#api" className="hover:text-emerald-500">
            API
          </a>
          <Link href="/failures" className="hover:text-emerald-500">
            Failure index
          </Link>
          <Link href="/stats" className="hidden hover:text-emerald-500 sm:inline">
            Usage
          </Link>
        </nav>
      </header>

      <section className="pt-16 pb-12 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Failed transaction in.
          <br />
          <span className="text-emerald-500">Working transaction out.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-neutral-500 dark:text-neutral-400">
          TxWhy finds the exact reason a Solana transaction failed, rebuilds it, and proves the
          rebuilt one works by simulating it against live chain state. For people, bots and AI
          agents.
        </p>

        <form onSubmit={submit} className="mx-auto mt-8 max-w-2xl">
          <div className="flex w-full gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Transaction signature or explorer URL"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-4 py-3 font-mono text-sm outline-none focus:border-emerald-500 dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-emerald-600 px-5 py-3 font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {loading ? "Tracing…" : "Diagnose"}
            </button>
          </div>
          {error && <p className="mt-2 text-left text-sm text-red-500">{error}</p>}
        </form>

        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-sm">
          <span className="text-neutral-500">Try one:</span>
          {EXAMPLES.map((ex) => (
            <Link
              key={ex.signature}
              href={`/tx/${ex.signature}`}
              className="text-emerald-600 hover:underline dark:text-emerald-400"
            >
              {ex.label}
            </Link>
          ))}
        </div>
        <p className="mt-3 text-sm">
          <Link href="/repair" className="text-emerald-600 hover:underline dark:text-emerald-400">
            Not sent yet? Repair it before you send, or watch a live demo →
          </Link>
        </p>
      </section>

      <section className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">Why this exists</h2>
        <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          On a busy day somewhere between one in eight and one in two Solana transactions fail. Bots
          and agents fail more than half of what they send, and the priority fee is burned every
          time. What they get back is a code like{" "}
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-sm dark:bg-neutral-900">
            Custom(6001)
          </code>
          . Explorers and AI explainers tell you what happened. TxWhy hands you the transaction that
          works.
        </p>
      </section>

      <section className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">How it works</h2>
        <ol className="mt-5 grid gap-4 sm:grid-cols-3">
          {[
            ["Diagnose", "Replays the transaction, walks every inner call, and pins the exact step that broke and why."],
            ["Rebuild", "Applies the fix that matches the cause and leaves everything else exactly as you wrote it."],
            ["Prove", "Simulates the rebuilt transaction on live state. You only get it back if it passes."],
          ].map(([title, body], i) => (
            <li key={title} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
              <p className="font-mono text-xs text-emerald-500">0{i + 1}</p>
              <p className="mt-1 font-semibold">{title}</p>
              <p className="mt-1 text-sm leading-relaxed text-neutral-500">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-neutral-500">
          The rebuilt transaction comes back unsigned. You sign it with your own wallet. TxWhy never
          sees a key.
        </p>
      </section>

      <section className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">What it handles today</h2>
        <ul className="mt-5 divide-y divide-neutral-200 dark:divide-neutral-800">
          {FIXES.map((f) => (
            <li key={f.failure} className="flex gap-4 py-3">
              <span
                className={`mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  f.fixed
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-neutral-500/15 text-neutral-600 dark:text-neutral-400"
                }`}
              >
                {f.fixed ? "Fixes" : "Explains"}
              </span>
              <div>
                <p className="font-medium">{f.failure}</p>
                <p className="text-sm leading-relaxed text-neutral-500">{f.action}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-neutral-500">
          When something cannot be fixed by rebuilding, TxWhy says so. It will never hand back a
          transaction that would fail again.
        </p>
      </section>

      {SDK_PUBLISHED && (
        <section id="sdk" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
          <h2 className="text-xl font-bold tracking-tight">One line in your send loop</h2>
          <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
            Most failures happen at simulation, before anything is sent. So that is where the repair belongs. If your
            transaction passes, it is signed and sent and TxWhy is never contacted. If it would fail, it comes back
            rebuilt, is checked on your machine, and only then reaches your signer.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">
            npm i @txwhy/sdk
          </pre>
          <pre className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">
            {SDK}
          </pre>
          <p className="mt-3 text-sm text-neutral-500">
            From a terminal: <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">npx @txwhy/sdk &lt;signature&gt;</code>
          </p>
          <p className="mt-3 text-sm text-neutral-500">
            On @solana/kit? The same loop, with no web3.js and with version 1 transactions included:{" "}
            <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">import {"{ sendWithRepair }"} from &quot;@txwhy/sdk/kit&quot;</code>
            {" "}and pass your rpc, the transaction and your signer.
          </p>
        </section>
      )}

      <section id="explorer" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">In the explorer, where you actually land</h2>
        <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          When a transaction fails, the first thing anyone opens is the explorer page, and the explorer stops at{" "}
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-sm dark:bg-neutral-900">custom program error: 0x1771</code>. The TxWhy
          browser extension adds the missing paragraph on Solscan, Solana Explorer, SolanaFM and Orb: the failing
          instruction, the cause in plain words, what to do, and whether a rebuilt version passes right now. It reads only
          the signature from the URL and talks only to this site.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/extension-explorer.png" alt="The TxWhy panel on a failed transaction in Solana Explorer, explaining a tripped Lighthouse guard" className="mt-4 w-full rounded-xl border border-neutral-200 dark:border-neutral-800" loading="lazy" />
        <p className="mt-3 text-sm text-neutral-500">
          Free and open source, in{" "}
          <a href="https://github.com/SUNDRAM07/txwhy/tree/main/extension" className="text-emerald-600 hover:underline dark:text-emerald-400">
            extension/
          </a>{" "}
          in the repo. Load it unpacked from chrome://extensions until it is on the Web Store.
        </p>
      </section>

      <section id="proof" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">Proof, on chain</h2>
        <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          Two transactions on Solana mainnet you can open yourself. No screenshots, no staging.
        </p>
        <ul className="mt-4 space-y-3 text-sm leading-relaxed">
          <li className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="font-semibold">A repaired transaction that landed</p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              An agent built a swap on a stale quote. Without TxWhy it failed simulation with{" "}
              <code className="rounded bg-neutral-100 px-1 dark:bg-neutral-900">0x1771</code>. With one line, it was rebuilt
              from a fresh quote for the same trade, verified locally (four instructions untouched, same payer, same signers),
              signed by the agent, and landed in slot 449,732,359.
            </p>
            <a
              href="https://solscan.io/tx/5BaKDPgC4tK3prhiLGKFgHkcWTcvNGDBAjoBNiw9dTjx9o9v7DoX1qTwbks4W9uZPJKszju3MMMcoB5XZ6zXhymq"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block break-all font-mono text-xs text-emerald-600 hover:underline dark:text-emerald-400"
            >
              5BaKDPgC…zXhymq on Solscan →
            </a>
          </li>
          <li className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
            <p className="font-semibold">An agent that paid for a repair</p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              $0.001 in USDC over x402 for a verified slippage repair, settled only after the answer came back, network fee
              paid by the facilitator. No account, no API key.
            </p>
            <a
              href="https://solscan.io/tx/2t4hz3zmmBkAtVyNaMY48ot9uhP7uLLLogdq23PtzScHKmeTA276Gt8Y1uyyeDpNsUciaPhDzMiCQcPA9AcAUzrA"
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block break-all font-mono text-xs text-emerald-600 hover:underline dark:text-emerald-400"
            >
              2t4hz3zm…AcAUzrA on Solscan →
            </a>
          </li>
        </ul>
      </section>

      {USED_BY.length > 0 && (
        <section id="used-by" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
          <h2 className="text-xl font-bold tracking-tight">Used by</h2>
          <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
            Projects that put TxWhy in their send loop, and what they said. Every one of them is counted on the{" "}
            <Link href="/stats" className="text-emerald-600 hover:underline dark:text-emerald-400">
              usage page
            </Link>
            .
          </p>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2">
            {USED_BY.map((u) => (
              <li key={u.name} className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
                <a href={u.url} target="_blank" rel="noreferrer" className="font-semibold hover:text-emerald-500">
                  {u.name}
                </a>
                <span className="ml-2 text-xs text-neutral-500">{u.how}</span>
                {u.quote && <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">&ldquo;{u.quote}&rdquo;</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section id="verify" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">You never have to trust us</h2>
        <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          Signing a transaction that a server rebuilt should make you nervous. So every repair comes with a proof, and
          the check behind it is open source, has no network access, and runs on your machine. A repaired transaction
          may differ from yours in exactly three ways:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          <li>compute budget settings (limit, priority fee, loaded data size)</li>
          <li>
            one Jupiter swap instruction replaced by another for the same wallet, the same source and destination token
            accounts, the same output token, the same amount and the same slippage tolerance
          </li>
          <li>the recent blockhash</li>
        </ul>
        <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          Same fee payer, same signers, every other instruction byte for byte and in the same order. Anything else is
          refused. The test suite attacks it fifteen ways: an extra transfer, a redirected fee, a new signer, a widened
          slippage, swap proceeds sent to a stranger. All fifteen are caught. TxWhy runs the same check on its own
          output and will not return a transaction that fails it.
        </p>
        {SDK_PUBLISHED && (
          <pre className="mt-4 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">
            {VERIFY}
          </pre>
        )}
      </section>

      {X402_LIVE && (
        <section id="pricing" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
          <h2 className="text-xl font-bold tracking-tight">Free for people. A tenth of a cent for agents.</h2>
          <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
            The website, the bot and <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">/api/v1/repair</code>{" "}
            are free and rate limited. Agents that need guaranteed capacity call{" "}
            <code className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-900">/api/x402/repair</code> instead:
            $0.001 in USDC per repair over x402, no account, no API key, charged only when the answer succeeds. A
            repaired transaction that lands costs less than the priority fee on one that does not.
          </p>
        </section>
      )}

      <section id="api" className="border-t border-neutral-200 py-12 dark:border-neutral-800">
        <h2 className="text-xl font-bold tracking-tight">For agents and bots</h2>
        <p className="mt-3 leading-relaxed text-neutral-600 dark:text-neutral-400">
          One call inside your send loop. When your RPC rejects a transaction at simulation, pass it
          here and get back a version that passes, typically in under a second. Most failures never
          reach the chain. They happen at this step, and this is where TxWhy sits.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">
          {CURL}
        </pre>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed text-neutral-500 dark:border-neutral-800">
          {RESPONSE}
        </pre>
        <h3 className="mt-8 font-semibold">Or plug it into any agent as a tool</h3>
        <p className="mt-2 text-sm leading-relaxed text-neutral-500">
          TxWhy is an MCP server. Add the URL and your agent gets three tools:{" "}
          <code className="font-mono">repair_transaction</code>,{" "}
          <code className="font-mono">diagnose_transaction</code> and{" "}
          <code className="font-mono">explain_error</code>. No key, no account.
        </p>
        <pre className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 p-4 font-mono text-xs leading-relaxed dark:border-neutral-800">
          {MCP_CONFIG}
        </pre>
        <p className="mt-3 text-sm text-neutral-500">
          You can also pass{" "}
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono dark:bg-neutral-900">
            {`{"signature": "..."}`}
          </code>{" "}
          for a transaction that already landed and failed. Status is one of{" "}
          <code className="font-mono">repaired</code>, <code className="font-mono">valid</code>,{" "}
          <code className="font-mono">needs_requote</code> or{" "}
          <code className="font-mono">not_repairable</code>.
        </p>
      </section>

      <footer className="border-t border-neutral-200 pt-8 text-sm text-neutral-500 dark:border-neutral-800">
        Built for Solana. Entered in Colosseum&apos;s Crypto World&apos;s Fair.
      </footer>
    </main>
  );
}
