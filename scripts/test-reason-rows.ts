// The refusal rows on /failures: numbers blanked without eating the spaces around them, and the
// rows written by the old regex restored to the same spelling. Run: npx tsx scripts/test-reason-rows.ts
import { blankNumbers, cleanLegacyRow } from "../worker/reason";

let failed = 0;
function eq(name: string, got: string, want: string) {
  if (got === want) console.log(`ok   ${name}`);
  else { failed++; console.log(`FAIL ${name}\n     got  ${got}\n     want ${want}`); }
}

eq("spaces kept", blankNumbers("The token transfer at instruction #3 spends 5,000 from token account …, which holds 0. Usually the amount"),
  "The token transfer at instruction #N spends N from token account …, which holds N. Usually the amount");
eq("instruction names keep their digits", blankNumbers("The Meteora DBC swap2 spends 1,234.5 from token account …, which holds 12."),
  "The Meteora DBC swap2 spends N from token account …, which holds N.");
eq("percent", blankNumbers("moved more than 25% against this trade; both raised 25 %"), "moved more than N against this trade; both raised N");
eq("hex codes stay", blankNumbers("raised 0x1771 (6001) at #2"), "raised 0x1771 (N) at #N");
eq("decimals and SOL", blankNumbers("holds 1.4278 SOL of room left (10.1022 raised; 11.53 graduates it)"), "holds N SOL of room left (N raised; N graduates it)");
eq("version words", blankNumbers("Raydium AMM v4, Token-2022, DAMM v2"), "Raydium AMM v4, Token-2022, DAMM v2");
eq("lamports", blankNumbers("holds 1,000 lamports and needs 2,500"), "holds N lamports and needs N");
eq("sizes that name a thing", blankNumbers("no instruction with this 8-byte discriminator, a 64-bit amount, 3 accounts"), "no instruction with this 8-byte discriminator, a 64-bit amount, N accounts");

eq("legacy transfer row", cleanLegacyRow("Not enough tokens to transfer: The token transfer at instruction #Nspends Nfrom token account …, which holds NUsually th"),
  "Not enough tokens to transfer: The token transfer at instruction #N spends N from token account …, which holds N. Usually th");
eq("legacy swap2 row", cleanLegacyRow("Not enough tokens to swap: The Meteora DBC swapNspends Nfrom token account …, which holds NUsually the amount came from "),
  "Not enough tokens to swap: The Meteora DBC swap2 spends N from token account …, which holds N. Usually the amount came from ");
eq("legacy lamports row", cleanLegacyRow("Insufficient SOL: The paying account holds Nlamports and needs N"), "Insufficient SOL: The paying account holds N lamports and needs N");
eq("legacy size row", cleanLegacyRow("InstructionMissing: The program has no instruction with this N-byte discriminator"), "InstructionMissing: The program has no instruction with this 8-byte discriminator");
eq("clean rows unchanged", cleanLegacyRow("NonceAlreadyExists: This transaction fails for a reason that cannot be fixed by rebuilding it."),
  "NonceAlreadyExists: This transaction fails for a reason that cannot be fixed by rebuilding it.");
eq("titles starting with N unchanged", cleanLegacyRow("Not enough tokens to transfer: The token transfer at instruction #N spends N from token account …"),
  "Not enough tokens to transfer: The token transfer at instruction #N spends N from token account …");
eq("new rows are fixed points", cleanLegacyRow(blankNumbers("The Meteora DBC swap2 spends 1,234 from token account …, which holds 0. Usually")),
  blankNumbers("The Meteora DBC swap2 spends 1,234 from token account …, which holds 0. Usually"));

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
