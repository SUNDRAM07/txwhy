// Lighthouse guard decoding, on bytes taken from real mainnet transactions. No network.
//   npx tsx scripts/test-lighthouse.ts
import { LIGHTHOUSE, base58ToBytes, describeLighthouseAssertion, lighthouseCause, lighthouseDetail } from "../src/lib/lighthouse";
import { decodeTransactionError } from "../src/lib/errors";
import { isNamedProgram, programName } from "../src/lib/programs";

let pass = 0, total = 0;
const check = (name: string, ok: boolean, detail = "") => { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -> ${detail}` : ""}`); };
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const ACCOUNT = "F8w15ZZnSQiZxdNazTti6b1dsvapQXA2cYZCT7KTyAp5";

// Instruction #4 of 4eSSiRGP…kU2Bv (mainnet, Sep 30 2026): the guard that aborted a Jupiter + LaunchLab trade.
const real = base58ToBytes("AfehheFXYEfbVfjd6");
check("base58 decodes the real instruction", Buffer.from(real).toString("hex") === "02003d07f820a4000000000005");
const sentence = describeLighthouseAssertion(real, [ACCOUNT]);
check("account-data guard in words", sentence === "the 64-bit number at byte 61 of account F8w1…yAp5 to be at most 10,756,344", sentence ?? "null");

const balance = describeLighthouseAssertion(hex("0200400708" + "7d7c7700000000" + "04"), [ACCOUNT]);
check("byte 64 is called out as a token balance", /byte 64 of a token account is its balance/.test(balance ?? "") && /at least/.test(balance ?? ""), balance ?? "null");

const slot = describeLighthouseAssertion(hex("0f0000b75cf01a0000000005"), []);
check("slot deadline", slot === "the current slot to be at most 451,959,991 (an expiry: the transaction landed too late)", slot ?? "null");

const token = describeLighthouseAssertion(hex("090002" + "40420f0000000000" + "04"), [ACCOUNT]);
check("token-account amount guard", token === "the token balance of token account F8w1…yAp5 to be at least 1,000,000 (raw units)", token ?? "null");

const lamports = describeLighthouseAssertion(hex("050000" + "00ca9a3b00000000" + "04"), [ACCOUNT]);
check("lamports guard", lamports === "the SOL balance (in lamports) of account F8w1…yAp5 to be at least 1,000,000,000", lamports ?? "null");

check("memory write is not an assertion", describeLighthouseAssertion(hex("0000"), []) === null);
check("truncated data does not throw", describeLighthouseAssertion(hex("0200"), [ACCOUNT]) === null);
check("empty data does not throw", describeLighthouseAssertion(new Uint8Array(), []) === null);

const err = { InstructionError: [4, { Custom: 6001 }] };
const detail = lighthouseDetail(err, (i) => (i === 4 ? { programId: LIGHTHOUSE, accounts: [ACCOUNT], data: real } : undefined));
check("failing instruction is explained", detail?.title === "Lighthouse guard: assertion failed" && /Instruction #5 is a safety guard/.test(detail.cause) && /at most 10,756,344/.test(detail.cause), detail?.cause.slice(0, 120));
check("says it is not Jupiter slippage", /not Jupiter's slippage error/.test(detail?.cause ?? ""));
check("other programs are left alone", lighthouseDetail(err, () => ({ programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", accounts: [], data: real })) === null);
check("non-custom errors are left alone", lighthouseDetail({ InstructionError: [4, "InvalidAccountData"] }, () => ({ programId: LIGHTHOUSE, accounts: [], data: real })) === null);

const generic = decodeTransactionError(err, LIGHTHOUSE, [], null);
check("decoder names Lighthouse without the instruction", generic?.title === "Lighthouse guard: assertion failed" && !/private program/.test(generic.cause));
check("Lighthouse is a named program", isNamedProgram(LIGHTHOUSE) && /Lighthouse/.test(programName(LIGHTHOUSE)));
check("other Lighthouse codes are named", lighthouseCause(6011).title === "Lighthouse guard: AccountNotInitialized");

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
