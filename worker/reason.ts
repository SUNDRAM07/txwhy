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
