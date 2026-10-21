// Classify the two divergences: rent parameters, pre-funded ATA addresses, and every BuyExactSolIn account's lamports against the rent minimum on both sides.
const MAIN = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const SURF = process.env.SURFNET_RPC_URL ?? "http://127.0.0.1:8899";
const PUMP = "48QY3d2GoR5zhFA6ZCvyxJmcMZQ9KvnTMujUjpC2u4J8gm2yqRnhKynuCiw6Vz9uUVoWxmu85L2eD7hMXdeX1i24";
const DBC = "3jhcCvczVZAfp6rTxWm6gsXsjHNphgVVH5iqYUKZAuCzbXJMaX47JScw2fHrhfKNm3W8vyurZVv97jgDvKbzzHPM";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
async function rpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
  const j = await res.json();
  if (j.error) throw new Error(`${method} on ${url}: ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (a: any) => (a ? `${a.lamports} lamports, ${Buffer.from(a.data[0], "base64").length} bytes, owner ${a.owner.slice(0, 10)}` : "missing");
async function main() {
  const [m0, s0, m165, s165] = await Promise.all([
    rpc(MAIN, "getMinimumBalanceForRentExemption", [0]), rpc(SURF, "getMinimumBalanceForRentExemption", [0]),
    rpc(MAIN, "getMinimumBalanceForRentExemption", [165]), rpc(SURF, "getMinimumBalanceForRentExemption", [165]),
  ]);
  console.log(`rent minimum for 0 bytes: mainnet ${m0}, surfnet ${s0}; for 165 bytes: mainnet ${m165}, surfnet ${s165}`);
  await sleep(1200);
  const dbc = await rpc(MAIN, "getTransaction", [DBC, { maxSupportedTransactionVersion: 1, encoding: "json" }]);
  const dkeys: string[] = dbc.transaction.message.accountKeys;
  const atas = dbc.transaction.message.instructions.filter((ix: any) => dkeys[ix.programIdIndex] === ATA_PROGRAM).map((ix: any) => dkeys[ix.accounts[1]]);
  await sleep(1200);
  for (const ata of atas) {
    const [m, s] = await Promise.all([rpc(MAIN, "getAccountInfo", [ata, { encoding: "base64" }]), rpc(SURF, "getAccountInfo", [ata, { encoding: "base64" }])]);
    console.log(`DBC ATA ${ata}: mainnet ${fmt(m.value)} | surfnet ${fmt(s.value)}`);
    await sleep(800);
  }
  const tx = await rpc(MAIN, "getTransaction", [PUMP, { maxSupportedTransactionVersion: 1, encoding: "json" }]);
  const keys: string[] = tx.transaction.message.accountKeys;
  const pumpIx = tx.transaction.message.instructions.find((ix: any) => keys[ix.programIdIndex] === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const pumpKeys = pumpIx.accounts.map((i: number) => keys[i]);
  await sleep(1200);
  const [mAll, sAll] = await Promise.all([rpc(MAIN, "getMultipleAccounts", [pumpKeys, { encoding: "base64" }]), rpc(SURF, "getMultipleAccounts", [pumpKeys, { encoding: "base64" }])]);
  console.log(`BuyExactSolIn accounts (index: mainnet | surfnet):`);
  pumpKeys.forEach((k: string, i: number) => console.log(`   #${i} ${k.slice(0, 12)}…: ${fmt(mAll.value[i])} | ${fmt(sAll.value[i])}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
