// Print instructions from a program's on-chain Anchor IDL (all, or one by name or discriminator hex).
//   npx tsx scripts/_idl-ix.ts <program> [nameOrDiscHex]
import { PublicKey } from "@solana/web3.js";
import { inflateSync } from "node:zlib";
const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
async function main() {
  const [program, want] = process.argv.slice(2);
  const programId = new PublicKey(program);
  const [base] = PublicKey.findProgramAddressSync([], programId);
  const idlAddress = await PublicKey.createWithSeed(base, "anchor:idl", programId);
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [idlAddress.toBase58(), { encoding: "base64" }] }) });
  const { result } = (await res.json()) as { result: { value: { data: [string, string] } | null } };
  if (!result?.value) { console.log("no IDL account"); return; }
  const raw = Buffer.from(result.value.data[0], "base64");
  const idl = JSON.parse(inflateSync(raw.subarray(44, 44 + raw.readUInt32LE(40))).toString("utf8")) as any;
  const hex = (d: number[]) => Buffer.from(d).toString("hex");
  if (process.env.DUMP) { const { writeFileSync } = await import("node:fs"); writeFileSync(process.env.DUMP, JSON.stringify(idl, null, 1)); console.log(`wrote ${process.env.DUMP}: ${idl.instructions.length} instructions, ${(idl.accounts ?? []).length} accounts, ${(idl.types ?? []).length} types`); if (!want) return; }
  const list = idl.instructions as any[];
  if (!want) { for (const ix of list) console.log(hex(ix.discriminator), ix.name, "args:", ix.args.map((a: any) => `${a.name}:${typeof a.type === "string" ? a.type : JSON.stringify(a.type)}`).join(", ")); return; }
  const ix = list.find((i) => i.name === want || hex(i.discriminator) === want.toLowerCase());
  if (!ix) { console.log("not found; names:", list.map((i) => i.name).join(", ")); return; }
  console.log(JSON.stringify({ name: ix.name, discriminator: hex(ix.discriminator), accounts: ix.accounts.map((a: any, i: number) => `${i}:${a.name}${a.writable ? " (w)" : ""}${a.signer ? " (s)" : ""}`), args: ix.args }, null, 1));
  for (const a of ix.args) {
    const t = a.type?.defined?.name;
    if (t) { const def = idl.types?.find((x: any) => x.name === t); if (def) console.log(`type ${t}:`, JSON.stringify(def.type)); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
