// How often does a landed Jupiter slippage failure lose its re-quote because the swap's source token account is created
// inside the same transaction (so it does not exist on chain when the engine looks)? Runs recent 0x1771 failures through
// the engine and tallies the re-quote reason.  npx tsx scripts/_jup-source-mint.ts [count]
import { repair } from "../src/lib/repair";
import { rpc } from "../src/lib/rpc";

const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const N = Number(process.argv[2] ?? 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sigs = await rpc<{ signature: string; err: { InstructionError?: [number, { Custom?: number }] } | null }[]>("getSignaturesForAddress", [JUP, { limit: 1000 }]);
  const slip = sigs.filter((s) => s.err?.InstructionError?.[1]?.Custom === 6001);
  console.log(`${slip.length} SlippageToleranceExceeded among ${sigs.filter((s) => s.err).length} failed of ${sigs.length}`);
  const step = Math.max(1, Math.floor(slip.length / N));
  const tally: Record<string, number> = {};
  const examples: Record<string, string> = {};
  for (const s of slip.filter((_, i) => i % step === 0).slice(0, N)) {
    await sleep(1200);
    let key: string;
    try {
      const r = await repair({ signature: s.signature });
      const note = r.notes.find((n) => /Could not resolve|Could not read|does not carry|runs inside|replaces at most one|New route|spliced in|moved more than|fits its own limit|fresh quote was/.test(n));
      key = `${r.status}: ${(note ?? r.summary).replace(/\d[\d,.]*/g, "N").slice(0, 90)}`;
    } catch (e) {
      key = `exception: ${String((e as Error).message).slice(0, 60)}`;
    }
    tally[key] = (tally[key] ?? 0) + 1;
    examples[key] = examples[key] ?? s.signature;
  }
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(3)}  ${k}\n       ${examples[k]}`);
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
