import PROGRAM_ERRORS from "./data/program-errors.json";
import { ANCHOR_ERRORS, SYSTEM_ERRORS, TOKEN_ERRORS, enrichCause, suggestFixForName } from "./errors";
import type { DecodedError } from "./types";

/**
 * A browsable catalog of every error code TxWhy can name, built from the same tables the
 * decoder uses. Powers the /errors pages, so that someone searching "0x1771" or
 * "Custom 6001 Raydium" lands on an answer and a way to repair the transaction.
 */

export interface CatalogError {
  code: number;
  hex: string;
  name: string;
  /** The program's own published message, when it has one. */
  message?: string;
  cause: string;
  fix: string;
  /** How TxWhy treats this failure when it sees it in a transaction. */
  repair: "requote" | "diagnose";
}

export interface CatalogProgram {
  slug: string;
  name: string;
  /** Program address. Absent for framework-level tables such as Anchor. */
  address?: string;
  blurb: string;
  errors: CatalogError[];
}

const BUNDLED = PROGRAM_ERRORS as unknown as Record<string, { name: string; errors: Record<string, string[]> }>;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const hex = (code: number) => `0x${code.toString(16)}`;

const isSlippage = (name: string) => {
  const n = name.toLowerCase();
  return n.includes("slippage") || n.includes("toolittle") || n.includes("belowmin") || n.includes("amountoutbelow");
};

function fromKnowledgeBase(table: Record<number, DecodedError>): CatalogError[] {
  return Object.entries(table)
    .map(([code, e]) => ({
      code: Number(code),
      hex: hex(Number(code)),
      name: e.title,
      cause: e.cause,
      fix: e.fix,
      repair: "diagnose" as const,
    }))
    .sort((a, b) => a.code - b.code);
}

function build(): CatalogProgram[] {
  const programs: CatalogProgram[] = [];
  for (const [address, program] of Object.entries(BUNDLED)) {
    const errors = Object.entries(program.errors)
      .map(([code, [name, message]]) => {
        const n = Number(code);
        return {
          code: n,
          hex: hex(n),
          name,
          message: message || undefined,
          cause: enrichCause(name, message),
          fix:
            suggestFixForName(name) ??
            "The error name is the program's own diagnosis. Paste the failed transaction into TxWhy to see which instruction raised it and with which accounts.",
          repair: isSlippage(name) ? ("requote" as const) : ("diagnose" as const),
        };
      })
      .sort((a, b) => a.code - b.code);
    programs.push({
      slug: slugify(program.name),
      name: program.name,
      address,
      blurb: `Every custom error code published by ${program.name}, with what it means and what to do about it.`,
      errors,
    });
  }
  programs.push(
    {
      slug: "anchor",
      name: "Anchor framework",
      blurb:
        "Codes 100 to 4100 are raised by the Anchor framework itself, not by the program's own logic, so they mean the same thing in every Anchor program.",
      errors: fromKnowledgeBase(ANCHOR_ERRORS),
    },
    {
      slug: "spl-token",
      name: "SPL Token",
      address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      blurb: "Custom error codes of the SPL Token program. Token-2022 shares the same first twenty codes.",
      errors: fromKnowledgeBase(TOKEN_ERRORS),
    },
    {
      slug: "system-program",
      name: "System Program",
      address: "11111111111111111111111111111111",
      blurb: "The System Program's error codes are small integers that look meaningless on their own.",
      errors: fromKnowledgeBase(SYSTEM_ERRORS),
    },
  );
  return programs.sort((a, b) => a.name.localeCompare(b.name));
}

const CATALOG = build();
const BY_SLUG = new Map(CATALOG.map((p) => [p.slug, p]));

export const listPrograms = (): CatalogProgram[] => CATALOG;
export const getProgram = (slug: string): CatalogProgram | undefined => BY_SLUG.get(slug);

/** Accepts a decimal code ("6001") or a hex one ("0x1771"). */
export function getError(slug: string, code: string): { program: CatalogProgram; error: CatalogError } | undefined {
  const program = BY_SLUG.get(slug);
  if (!program) return undefined;
  const n = /^0x[0-9a-f]+$/i.test(code) ? parseInt(code, 16) : /^\d+$/.test(code) ? Number(code) : NaN;
  const error = program.errors.find((e) => e.code === n);
  return error ? { program, error } : undefined;
}

/** Every program that uses this code, for "the same number means something else elsewhere". */
export function sameCodeElsewhere(code: number, exceptSlug: string): { program: CatalogProgram; error: CatalogError }[] {
  const out: { program: CatalogProgram; error: CatalogError }[] = [];
  for (const program of CATALOG) {
    if (program.slug === exceptSlug) continue;
    const error = program.errors.find((e) => e.code === code);
    if (error) out.push({ program, error });
  }
  return out;
}

export const catalogSize = () => CATALOG.reduce((sum, p) => sum + p.errors.length, 0);

const BY_ADDRESS = new Map(CATALOG.filter((p) => p.address).map((p) => [p.address as string, p]));

/** The catalog page for a program address and numeric code, when we have one. Anchor-range codes fall back to the framework table. */
export function findError(address: string | null | undefined, code: number): { program: CatalogProgram; error: CatalogError } | undefined {
  const program = address ? BY_ADDRESS.get(address) : undefined;
  const own = program?.errors.find((e) => e.code === code);
  if (program && own) return { program, error: own };
  const anchor = BY_SLUG.get("anchor");
  const framework = anchor?.errors.find((e) => e.code === code);
  return anchor && framework ? { program: anchor, error: framework } : undefined;
}
