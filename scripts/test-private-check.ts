// A private program's own named check: what the decoder says, and how the worker files it.
// Logs are from landed mainnet failures. Run: npx tsx scripts/test-private-check.ts
import { decodeTransactionError } from "../src/lib/errors";
import { reasonKey, whyNot } from "../worker/reason";

let failed = 0;
function ok(name: string, pass: boolean, detail = "") {
  if (!pass) failed++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : `\n     ${detail}`}`);
}
const custom = (index: number, code: number) => ({ InstructionError: [index, { Custom: code }] });
const verdict = (cause: { title: string; cause: string } | null, notes: string[] = []) => ({ status: "not_repairable", summary: cause?.cause ?? "", cause, notes });

// 4MfdL5r46E12…guUY4, Nov 6 2026: one of about 1,400 a minute from one sender.
const GUARD = "52Yyvsugd3B7waLEFB83hdTmcwtU66tBuEzTQ7kcfoAi";
const guardLogs = [
  `Program ${GUARD} invoke [1]`,
  "Program log: Instruction: BuyExactQuoteInV3",
  "Program log: AnchorError thrown in programs/pump_buy_guard/src/lib.rs:62. Error Code: QuoteReserveThresholdReached. Error Number: 6017. Error Message: 6018.",
  `Program ${GUARD} consumed 33867 of 157749 compute units`,
  `Program ${GUARD} failed: custom program error: 0x1781`,
];
const guard = decodeTransactionError(custom(3, 6017), GUARD, guardLogs)!;
ok("the title stays the check's own name", guard.title === "QuoteReserveThresholdReached", guard.title);
ok("says it is a private program's own check, with the program and its crate", /^A private program's own check, QuoteReserveThresholdReached, stopped this transaction \(program 52Yy…foAi; its source calls it pump_buy_guard\)\./.test(guard.cause), guard.cause);
ok("the bare-number message is not passed off as an explanation", !/6018/.test(guard.cause) && !/Its own message/.test(guard.cause), guard.cause);
ok("the fix says there is nothing to rebuild and whose rule it is", /^Nothing to rebuild/.test(guard.fix) && /trading app or bot/.test(guard.fix), guard.fix);
ok("worker bucket: private_program", whyNot(verdict(guard)) === "private_program", whyNot(verdict(guard)));
ok("still private_program when the replay drifted since", whyNot(verdict(guard, ['Re-run today, this transaction fails earlier than it did on chain ("CreatorVaultBalanceTooLow") because the accounts and prices it referenced have since changed.'])) === "private_program");
const row = reasonKey(guard.title, guard.cause);
ok("ranked row sits under the private-program heading and keeps the check's name", /^Private program \(unnamed\): A private program's own check, QuoteReserveThresholdReached,/.test(row), row);
ok("the row counts as bot flow in the segments", /^Private program \(unnamed\)|circular arbitrage/.test(row));

// A message that does say something is quoted.
const talkative = decodeTransactionError(custom(0, 6003), GUARD, [
  "Program log: AnchorError thrown in programs/entry_rules/src/lib.rs:88. Error Code: MarketCapAboveLimit. Error Number: 6003. Error Message: Market cap is above the limit set for this buy.",
])!;
ok("an informative message is quoted", /Its own message: "Market cap is above the limit set for this buy"\./.test(talkative.cause), talkative.cause);

// What must not change.
const slip = decodeTransactionError(custom(0, 6001), GUARD, ["Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6001. Error Message: Slippage exceeded."])!;
ok("a private router's slippage error keeps the slippage explanation", /less than the minimum this transaction allowed/.test(slip.cause) && !/own check/.test(slip.cause), slip.cause);
const dup = decodeTransactionError(custom(0, 6000), GUARD, ["Program log: AnchorError occurred. Error Code: NonceAlreadyExists. Error Number: 6000. Error Message: Nonce already exists."])!;
ok("a private program's duplicate-order error keeps the duplicate explanation", /already used/.test(dup.cause) && !/own check/.test(dup.cause), dup.cause);
ok("  and its bucket", whyNot(verdict(dup)) === "duplicate_send");
const framework = decodeTransactionError(custom(0, 3012), GUARD, ["Program log: AnchorError caused by account: user_token. Error Code: AccountNotInitialized. Error Number: 3012. Error Message: The program expected this account to be already initialized."])!;
ok("Anchor framework codes (below 6000) keep the framework's explanation", !/own check/.test(framework.cause), framework.cause);
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const publicProgram = decodeTransactionError(custom(0, 6017), PUMP, ["Program log: AnchorError thrown in programs/pump/src/lib.rs:10. Error Code: SomethingNew. Error Number: 6017. Error Message: 6018."])!;
ok("a public program's error is never called a private check", !/own check/.test(publicProgram.cause), publicProgram.cause);
const unnamed = decodeTransactionError(custom(0, 7), GUARD, [`Program ${GUARD} failed: custom program error: 0x7`])!;
ok("a private program with no named error keeps the unnamed wording", /from a private program/.test(unnamed.title) && whyNot(verdict(unnamed)) === "private_program", unnamed.title);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
