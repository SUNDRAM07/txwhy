import DEX_LABELS from "./data/dex-labels.json";
import PROGRAM_ERRORS from "./data/program-errors.json";

/** Known-program registry - layer 1 of the decoder. */
export const KNOWN_PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System Program",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "Meteora DBC",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "Meteora DAMM v2",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Vote111111111111111111111111111111111111111: "Vote Program",
  Stake11111111111111111111111111111111111111: "Stake Program",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  Ed25519SigVerify111111111111111111111111111: "Ed25519 Signature Verify",
  KeccakSecp256k11111111111111111111111111111: "Secp256k1 Signature Verify",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "Pump.fun",
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse (assertion guard)",
};

/** Exchange programs Jupiter routes through, from Jupiter's own program-id-to-label list. */
const DEX = DEX_LABELS as Record<string, string>;
/** Programs whose error tables we bundle also carry a display name. */
const BUNDLED = PROGRAM_ERRORS as unknown as Record<string, { name: string }>;

/** True when we can put a real name on the program. */
export function isNamedProgram(programId: string): boolean {
  return Boolean(KNOWN_PROGRAMS[programId] ?? DEX[programId] ?? BUNDLED[programId]);
}

export function programName(programId: string, parsedProgram?: string): string {
  const named = KNOWN_PROGRAMS[programId] ?? DEX[programId] ?? BUNDLED[programId]?.name;
  if (named) return named;
  if (parsedProgram) return parsedProgram;
  return programId.slice(0, 4) + "…" + programId.slice(-4);
}
