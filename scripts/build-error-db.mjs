// Regenerates src/lib/data/program-errors.json from the MIT-licensed `solana-idls` dataset.
// Usage: npm i -D solana-idls && node scripts/build-error-db.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const m = createRequire(import.meta.url)("solana-idls");
const out = {};
let total = 0;
for (const key of Object.keys(m)) {
  if (!key.endsWith("_PROGRAM_ID")) continue;
  const idl = m[key.slice(0, -"_PROGRAM_ID".length) + "_IDL"];
  const errors = idl?.errors ?? [];
  if (!errors.length) continue;
  const programId = String(m[key]);
  const meta = m.registry.getByProgramId?.(programId);
  out[programId] = {
    name: String(meta?.name ?? idl.metadata?.name ?? idl.name ?? key),
    errors: Object.fromEntries(errors.map((e) => [e.code, e.msg && e.msg !== e.name ? [e.name, e.msg] : [e.name]])),
  };
  total += errors.length;
}
// Programs the upstream dataset does not carry, maintained here by hand (source: the program's own repository).
const EXTRA_PROGRAMS = {"L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95": {"name": "Lighthouse", "errors": {"6000": ["InvalidInstructionData", "Invalid instruction"], "6001": ["AssertionFailed", "A state guard placed by the wallet or app did not hold at execution"], "6002": ["NotEnoughAccounts", "NotEnoughAccounts"], "6003": ["BumpNotFound", "BumpNotFound"], "6004": ["AccountBorrowFailed", "AccountBorrowFailed"], "6005": ["RangeOutOfBounds", "RangeOutOfBounds"], "6006": ["IndexOutOfBounds", "IndexOutOfBounds"], "6007": ["FailedToDeserialize", "FailedToDeserialize"], "6008": ["FailedToSerialize", "FailedToSerialize"], "6009": ["AccountOwnerMismatch", "AccountOwnerMismatch"], "6010": ["AccountKeyMismatch", "AccountKeyMismatch"], "6011": ["AccountNotInitialized", "AccountNotInitialized"], "6012": ["AccountOwnerValidationFailed", "AccountOwnerValidationFailed"], "6013": ["AccountFundedValidationFailed", "AccountFundedValidationFailed"], "6014": ["AccountDiscriminatorValidationFailed", "AccountDiscriminatorValidationFailed"], "6015": ["AccountValidationFailed", "AccountValidationFailed"], "6016": ["CrossProgramInvokeViolation", "CrossProgramInvokeViolation"]}}};
Object.assign(out, EXTRA_PROGRAMS);
writeFileSync(new URL("../src/lib/data/program-errors.json", import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(out).length} programs, ${total} errors`);
