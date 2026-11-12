// Why does a landed version 1 Jupiter swap fail token resolution? Decodes the bytes with the engine's v1 decoder and
// runs readSwapIntent on them, printing the three keys the layout points at.  npx tsx scripts/_v1-intent.ts <sig>
import { decodeV1 } from "../src/lib/v1";
import { readSwapIntent } from "../src/lib/requote";
import { JUPITER_V6, LAYOUTS } from "../src/lib/swap-shape";
import { rpc } from "../src/lib/rpc";

async function main() {
  const sig = process.argv[2];
  const r = await rpc<{ transaction: [string, string] } | null>("getTransaction", [sig, { encoding: "base64", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  if (!r) throw new Error("not found");
  const decoded = decodeV1(r.transaction[0]);
  const ixs = decoded.instructions;
  console.log("instructions", ixs.length, "payer", decoded.payerKey.toBase58());
  const jup = ixs.filter((ix) => ix.programId.toBase58() === JUPITER_V6);
  for (const ix of jup) {
    const disc = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
    const layout = LAYOUTS[disc];
    console.log("jupiter ix: disc", disc, "layout", layout?.name, "keys", ix.keys.length, "data", ix.data.length);
    if (!layout) continue;
    const k = (i: number) => ix.keys[i]?.pubkey.toBase58();
    console.log("  user", k(layout.user), "destMint", k(layout.destinationMint), "sourceMint", typeof layout.sourceMint === "number" ? k(layout.sourceMint) : `tokenAccount ${k(layout.sourceMint.tokenAccount)}`);
    if (typeof layout.sourceMint !== "number") {
      const acc = await rpc<{ value: { data?: { parsed?: { info?: { mint?: string } } } } | null }>("getAccountInfo", [k(layout.sourceMint.tokenAccount), { encoding: "jsonParsed", commitment: "confirmed" }]);
      console.log("  source token account now:", acc.value ? JSON.stringify(acc.value.data?.parsed?.info?.mint ?? acc.value.data).slice(0, 120) : "DOES NOT EXIST (closed)");
    }
  }
  const intent = await readSwapIntent(ixs);
  console.log("intent:", JSON.stringify(intent).slice(0, 400));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
