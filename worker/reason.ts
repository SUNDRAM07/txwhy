/**
 * Text helpers for the refusal rows the worker publishes: a reason is blanked of its numbers and
 * addresses so the same kind of failure lands on the same row of the ranked list, without losing
 * the spaces and punctuation around them.
 */

/** The sentence the engine used for a refusal it could not explain, kept as a row until the cause text replaced it. */
export const GENERIC_REFUSAL = "This transaction fails for a reason that cannot be fixed by rebuilding it.";

/**
 * A number to blank: an integer, a decimal, a thousands-separated figure, optionally followed by a
 * percent sign. Digits attached to a word ("swap2", "Token-2022", "v0") are part of its name and stay.
 * Hex codes ("0x1771") and sizes that name a thing ("8-byte", "64-bit") are names too.
 */
const NUMBER = /\b0x[0-9a-fA-F]+\b|(?<![A-Za-z0-9-])-?\d[\d,]*(?:\.\d+)?(?:\s?%)?(?!\d|-[A-Za-z])/g;

/** "instruction #3 spends 5,000 from … holds 0. Usually" becomes "instruction #N spends N from … holds N. Usually". */
export function blankNumbers(text: string): string {
  return text.replace(NUMBER, (m) => (m.startsWith("0x") ? m : "N"));
}

/**
 * Rows written before blankNumbers kept its spaces read "#Nspends Nfrom", "holds NUsually" and
 * "swapNspends" (the instruction is called swap2). This restores their spelling so old and new rows
 * merge; a row that is already clean comes back unchanged.
 */
export function cleanLegacyRow(member: string): string {
  return member
    .replace(/\bswapN(?=spends)/g, "swap2 ")
    .replace(/\bswapN\b/g, "swap2")
    .replace(/#N(?=[a-z])/g, "#N ")
    .replace(/(?<=[ #])N(?=(?:spends|from|lamports|tokens|and|of|to|at|in|more|with|which|but|so|the|this|for|than|per|on|by|is|are|was|were|has|have|out|into)\b)/g, "N ")
    .replace(/ N(?=[A-Z][a-z])/g, " N. ")
    .replace(/\bN-byte\b/g, "8-byte");
}

/** "Title: reason" with numbers and addresses blanked, so the same kind of failure lands on the same row of the ranked list. */
export function reasonKey(title: string | undefined, summary: string): string {
  const reason = blankNumbers(summary.replace(/[1-9A-HJ-NP-Za-km-z]{32,}/g, "…").replace(/[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}/g, "…"));
  // Every private-program error is the same story for us (no published error list), so they share one row.
  // A private program's own named check is the same story with a name on it: it shares the heading and the row keeps the name.
  const t = /from a private program/i.test(title ?? "") || /^A private program's own check/.test(summary) ? "Private program (unnamed)" : (title ?? "").replace(/\([^)]*\)/g, "").trim();
  return `${t ? `${t}: ` : ""}${reason}`.slice(0, 120);
}

/**
 * One precise reason a landed failure was not rebuilt, read from the engine's own notes. The ranked
 * title list says WHAT failed; this says WHY the engine left it alone, which is what decides the next
 * thing to build and keeps the published numbers honest about bots and routers.
 */
export function whyNot(result: { status: string; summary: string; cause: { title: string } | null; notes: string[] }): string {
  const text = `${result.cause?.title ?? ""} ${result.summary} ${result.notes.join(" ")}`;
  if (/circular arbitrage/i.test(text)) return "arbitrage";
  if (/Lighthouse guard|safety guard set by the wallet/i.test(text)) return "wallet_guard";
  // Before the replay-drift check: a check that refused on chain by design is the cause, whatever the accounts say today.
  if (/A private program's own check,/.test(text)) return "private_program";
  if (/chains \d+ direct swaps|carries \d+ Jupiter swap instructions|more than one swap instruction/.test(text)) return "chained_swaps";
  if (/completed its bonding curve|BondingCurveComplete|bonding curve has completed/.test(text)) return "pool_graduated";
  if (/Launch pool nearly full|Launch curve nearly sold out|room left before it graduates|left before it completes|NotEnoughTokensToBuy|InsufficientLiquidity|SwapAmountIsOverAThreshold/.test(text)) return "pool_nearly_full";
  if (/NonceAlreadyExists/.test(result.cause?.title ?? "")) return "duplicate_send";
  if (/fee-recipient check refused/.test(text)) return "fee_recipient_rejected";
  if (/overflowed inside its fee arithmetic/.test(text)) return "pump_fee_overflow";
  if (/because its amount is zero|^ZeroAmount|sell amount is zero|amount is zero/i.test(text)) return "zero_amount";
  if (/frozen by the mint's freeze authority|^AccountFrozen/.test(text)) return "account_frozen";
  if (/still fails simulation, on the same slippage check/.test(text)) return "moved_again";
  if (/moved more than \d+% against this trade/.test(text)) return "beyond_cap";
  if (/No swap found that TxWhy can re-quote|not a top-level instruction|inside another program by CPI|runs inside another program/.test(text)) return "routed_by_private_program";
  if (/spliced in but the transaction still fails|lifted the transaction still fails|both raised \d+%/.test(text)) return "more_than_slippage";
  if (/above the 1232-byte limit|does not fit Solana's size limit|encoding overruns/.test(text)) return "too_large";
  if (/fits its own limit/.test(text)) return "not_slippage_now";
  if (/Re-run today, this transaction fails earlier/.test(text)) return "state_changed_since";
  if (/from a private program/i.test(result.cause?.title ?? "")) return "private_program";
  if (/^Invalid instruction data|InstructionMissing|InstructionDidNotDeserialize|InstructionFallbackNotFound|could not parse the instruction data|no instruction with this/.test(text)) return "client_data_mismatch";
  if (/^AccountNotInitialized|^Nothing to sell|does not exist yet \(no data at that address\)/.test(text)) return "missing_account";
  if (/InvalidSqrtPriceLimitDirection|TickArraySequenceInvalidIndex|InvalidTickArraySequence|TickArrayIndexOutofBounds|IncorrectSwapProgramId|^Invalid account data|InvalidAccountData|InvalidTokenAccount/.test(text)) return "client_built_wrong";
  if (/insufficient|holds .* lamports and needs|Shortfall|does not hold enough|NotEnoughTokensToSell|Not enough (tokens|SOL)/i.test(text)) return "no_funds";
  if (result.status === "needs_requote") return "needs_requote_other";
  return "other";
}
