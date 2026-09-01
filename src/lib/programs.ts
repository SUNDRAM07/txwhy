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
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Vote111111111111111111111111111111111111111: "Vote Program",
};

export function programName(programId: string, parsedProgram?: string): string {
  if (KNOWN_PROGRAMS[programId]) return KNOWN_PROGRAMS[programId];
  if (parsedProgram) return parsedProgram;
  return programId.slice(0, 4) + "…" + programId.slice(-4);
}
