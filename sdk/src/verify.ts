/**
 * The offline verifier, exactly the code the TxWhy server runs on its own output.
 * No network, no runtime dependencies.
 */
export { verifyInstructions } from "../../src/lib/verify";
export type { InstructionChange, Verification } from "../../src/lib/verify";
export { readSwapShape } from "../../src/lib/swap-shape";
