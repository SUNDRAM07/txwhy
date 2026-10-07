# Brand — TxWhy

_Status: active (documented from the shipped site, Oct 7, 2026)_

## Palette

One accent, neutral everything else. Tailwind tokens only; no hex values in components.

| Role | Light | Dark |
|---|---|---|
| Background | `bg-white` via `--background` | `#0a0a0a` via `--background` |
| Foreground | `#171717` | `#ededed` |
| Accent (links, verdicts that passed, the "Why" in the wordmark) | `emerald-600` / `emerald-700` on text, `emerald-500` on the wordmark and focus rings | `emerald-400` on text |
| Muted text | `neutral-600` | `neutral-400` |
| Borders and dividers | `neutral-200` | `neutral-800` |
| Raised surfaces (code, terminal) | `neutral-50` / `neutral-100` | `neutral-900` |
| Failure, refusal, "before" values | `red-600` | `red-400` |
| Warning (quote stale, needs a fresh quote) | `amber-600` | `amber-400` |

Semantic colours carry meaning only: green is "passes / repaired", red is "fails / refused", amber is "stale".

## Typography

- Sans: Geist (`--font-geist-sans`) for everything that is read.
- Mono: Geist Mono (`--font-geist-mono`) for signatures, addresses, amounts, code, and the repair replay. Numbers use `tabular-nums`.
- Display: `text-4xl sm:text-5xl font-bold tracking-tight`. Section titles: `text-2xl font-bold tracking-tight`. Body: `text-base` or `text-sm`, `leading-relaxed`.

## Shape and depth

- Cards and code blocks: `rounded-xl`, 1 px `neutral-200/800` border, no shadow. The one exception is the hero terminal (`rounded-2xl`, `shadow-sm`).
- Buttons: `rounded-lg`, min height 44 px, `active:translate-y-px`.
- Pills: `rounded-full`, tinted at 15% opacity.

## Motion

- Micro feedback 100 ms, colour and transform only. Never `transition-all`.
- The only choreographed motion on the site is the hero repair replay (once per visit, replayable) and the live counters (once). Nothing animates on scroll.
- Every animation respects `prefers-reduced-motion`: the finished state is shown at once.

## Voice

Plain, specific, honest. State the number. Say what was refused and why. "Failed transaction in. Working transaction out." No buzzwords, no exclamation marks, no claims that are not measured on the failure index.
