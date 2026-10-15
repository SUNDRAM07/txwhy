/**
 * What the replay of real mainnet failures taught us about specific error codes: the shape behind the
 * number, and what the engine does with it. Shown on the error-code pages under "Seen on mainnet", so a
 * search for the code lands on the measured answer, not only the program's one-line message.
 *
 * Keyed by program address and the error's name (names are stable across table refreshes; codes are
 * resolved from the catalog at render time).
 */

export const PUMP_FUN_ADDRESS = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP_ADDRESS = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const METEORA_DBC_ADDRESS = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const METEORA_DAMM_V2_ADDRESS = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const RAYDIUM_V4_ADDRESS = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
export const RAYDIUM_LAUNCHLAB_ADDRESS = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
export const JUPITER_ADDRESS = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/** Programs whose swap instructions carry a limit rather than a tolerance; the engine repairs their slippage by moving only the limit. */
export const DIRECT_SWAP_PROGRAMS = new Set([PUMP_FUN_ADDRESS, PUMP_SWAP_ADDRESS, METEORA_DBC_ADDRESS, METEORA_DAMM_V2_ADDRESS, RAYDIUM_V4_ADDRESS, RAYDIUM_LAUNCHLAB_ADDRESS]);

const LIMIT_REPAIR =
  "This instruction carries a limit, not a tolerance, so a fresh quote is the wrong idea. TxWhy keeps the amount and every account, and moves only the limit to the price the chain itself computed in the failed run (read from the program's own check in the logs, or from a simulation with the limit lifted), with a 1% tolerance and never more than 25% against you. The result is returned only after it passes simulation, and the offline verifier refuses anything else.";

interface FieldNote {
  program: string;
  error: string;
  note: string;
}

const NOTES: FieldNote[] = [
  {
    program: PUMP_FUN_ADDRESS,
    error: "Overflow",
    note: "Raised inside sell_v2's fee arithmetic (programs/pump/src/lib.rs), right after the fee program prices the trade. Every case the replay sampled in October 2026 came through a router's percentage sell (an instruction such as SellBondingCurvePercentage calling sell_v2), never a direct sell. Nothing on your side is short. Sell the amount directly with the Pump SDK's sell builder, or a smaller amount through the router.",
  },
  {
    program: PUMP_FUN_ADDRESS,
    error: "NotAuthorized",
    note: "When the log line says fee_recipient.rs, the fee-recipient account the instruction passed as its second account was refused for that token. The client used a stale or generic recipient; Pump.fun accepts different recipients for some tokens. Rebuild the instruction with the recipient the Pump SDK reads from the global account for that mint; the amount and every other account are fine. TxWhy names the account passed and checks it against the protocol's current recipients.",
  },
  {
    program: PUMP_FUN_ADDRESS,
    error: "BuySlippageBelowMinTokensOut",
    note: `The newer buy_exact_sol_in and buy_exact_quote_in_v2 instructions: SOL in is fixed, min_tokens_out is the limit. ${LIMIT_REPAIR}`,
  },
  {
    program: PUMP_FUN_ADDRESS,
    error: "TooMuchSolRequired",
    note: `The classic buy: tokens out is fixed, max_sol_cost is the limit, and the curve moved past it. ${LIMIT_REPAIR} A SOL wrap funding the buy may rise with the limit, within the same cap.`,
  },
  {
    program: PUMP_FUN_ADDRESS,
    error: "TooLittleSolReceived",
    note: `The sell: tokens in is fixed, min_sol_output is the limit, and the curve moved below it. ${LIMIT_REPAIR}`,
  },
  {
    program: PUMP_FUN_ADDRESS,
    error: "BondingCurveComplete",
    note: "The curve has graduated and its liquidity has moved, or is moving, to PumpSwap. No swap against the curve can succeed any more; trade the token on PumpSwap instead. TxWhy answers this as final and names the pool state rather than retrying.",
  },
  {
    program: PUMP_FUN_ADDRESS,
    error: "NotEnoughTokensToBuy",
    note: "The buy asks for more tokens than the curve still holds before it graduates. Buy at most what is left, or use the exact-SOL-in buy, which takes what the curve can give. TxWhy reads the curve and answers with the room left.",
  },
  {
    program: PUMP_SWAP_ADDRESS,
    error: "ExceededSlippage",
    note: `PumpSwap's buy (max_quote_amount_in) and sell (min_quote_amount_out) carry a limit. ${LIMIT_REPAIR} In testing, the PumpSwap SDK's quote drifted 7% from the on-chain result, which is why the limit is never priced from SDK math.`,
  },
  {
    program: PUMP_SWAP_ADDRESS,
    error: "BuyMoreBaseAmountThanPoolReserves",
    note: "The buy asks for more of the token than the pool holds. Buy less; nothing moves the pool's reserves for you. TxWhy refuses this one with the figure rather than retrying it.",
  },
  {
    program: METEORA_DBC_ADDRESS,
    error: "InsufficientLiquidity",
    note: "On a dynamic bonding curve this is a buy larger than what is left before the pool graduates, not an empty pool. TxWhy reads the pool account through Meteora's SDK and answers with the room left (SOL raised so far, the graduation threshold, what the buy puts in): buy at most that, or send swap2 in partial-fill mode, which takes what the curve can still give.",
  },
  {
    program: METEORA_DBC_ADDRESS,
    error: "PoolIsCompleted",
    note: "The curve graduated. Its liquidity moved to a Meteora DAMM v2 pool, which TxWhy derives from the pool's config and migration fee option and names in the answer. Trade there; nothing against the curve can succeed any more.",
  },
  {
    program: METEORA_DBC_ADDRESS,
    error: "ExceededSlippage",
    note: `swap and swap2 (exact-in, partial-fill and exact-out modes) carry a limit. ${LIMIT_REPAIR}`,
  },
  {
    program: METEORA_DAMM_V2_ADDRESS,
    error: "ExceededSlippage",
    note: `swap and swap2 on DAMM v2 carry a limit. ${LIMIT_REPAIR} Meteora programs are over a third of everything TxWhy has rebuilt.`,
  },
  {
    program: RAYDIUM_V4_ADDRESS,
    error: "ExceededSlippage",
    note: `swap_base_in (minimum out) and swap_base_out (maximum in), both the OpenBook-era layout and the newer one. The price is read from the program's own ray_log line in the failed run. ${LIMIT_REPAIR} When the rebuilt swap fails again on the same check, the pool moved past the tolerance between pricing and the final check; TxWhy says so instead of returning it.`,
  },
  {
    program: RAYDIUM_LAUNCHLAB_ADDRESS,
    error: "ExceededSlippage",
    note: `buy_exact_in, sell_exact_in and the exact-out forms carry a limit. ${LIMIT_REPAIR} A sell built for 0 tokens fails earlier with Anchor's RequireGtViolated from sell_exact_in; TxWhy names that as a zero-amount trade, usually a percentage sell of an empty balance.`,
  },
  {
    program: JUPITER_ADDRESS,
    error: "SlippageToleranceExceeded",
    note: "About half of what explorers label with this code is not Jupiter at all: the Lighthouse guard program that wallets append uses the same number, 6001, for a failed assertion, and a guard cannot be repaired, only explained. TxWhy tells the two apart from the failing program. For a real Jupiter slippage failure it asks Jupiter for a fresh quote for the same tokens, amount and tolerance, replaces only the swap instruction, and refuses a route over 3% price impact or a quote more than 25% worse than the original.",
  },
];

const byKey = new Map(NOTES.map((n) => [`${n.program}:${n.error}`, n.note]));

/** The measured note for a program's error, if the replay has one. */
export function fieldNote(programAddress: string | undefined, errorName: string): string | undefined {
  return programAddress ? byKey.get(`${programAddress}:${errorName}`) : undefined;
}

/** The text of the "TxWhy can repair this one" box, by what the engine actually does for this program. */
export function repairBlurb(programAddress: string | undefined, repair: "requote" | "diagnose"): { title: string; text: string; cta: string } {
  if (repair === "requote" && programAddress && DIRECT_SWAP_PROGRAMS.has(programAddress)) {
    return {
      title: "TxWhy can repair this one",
      text: "This instruction carries a limit rather than a tolerance. TxWhy keeps the amount and every account, moves only the limit to the price the chain computed in the failed run (never more than 25% against you), keeps every other instruction byte for byte, and returns the result only after it passes simulation.",
      cta: "Repair",
    };
  }
  if (repair === "requote") {
    return {
      title: "TxWhy can repair this one",
      text: "When the swap was routed through Jupiter, TxWhy replaces only the stale swap instruction with a current quote for the same tokens, amount and slippage tolerance, keeps every other instruction byte for byte, and proves the result passes simulation.",
      cta: "Repair",
    };
  }
  return {
    title: "Have the transaction that failed with this?",
    text: "Paste its signature. TxWhy shows the exact instruction and inner call that raised the error, and rebuilds the transaction when the cause is one it can fix (compute limit, expired blockhash, priority fee, a stale swap quote or a moved limit).",
    cta: "Diagnose",
  };
}
