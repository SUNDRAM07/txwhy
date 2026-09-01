# TxWhy

**Paste a failed Solana transaction signature → see exactly why it failed and how to fix it.**

Orb explains what happened; TxWhy tells you how to fix it — a deterministic error→fix knowledge base, shareable diagnosis links, and pre-send simulation any app can embed.

## What it does

1. Paste a transaction signature (or an explorer URL — the signature is extracted).
2. TxWhy fetches the transaction, renders the full instruction/CPI tree, and highlights the failing instruction.
3. The error is decoded to plain English — cause + suggested fix — via a three-layer decoder:
   - **Known-program registry:** System, SPL Token, ATA, Compute Budget, Jupiter, Metaplex instruction labels.
   - **Anchor custom errors:** published IDLs map `Custom(N)` → error name + message.
   - **Knowledge base:** curated JSON mapping error patterns → { cause, fix }, seeded from the documented six-category failure taxonomy (account / balance / timing / program / provider / size). Community-extendable — every uncovered error becomes an issue → KB entry.
4. Every trace gets a shareable permalink (`/tx/[signature]`) — post a TxWhy link instead of raw logs.

## Why deterministic beats AI-only explanation

AI explainers regenerate an answer per query. TxWhy's knowledge base is curated, citable, and version-controlled — the same error always gets the same verified fix, with links to docs. And because it's a KB, anyone can extend it via PR.

## Stack

- Next.js (App Router) + TypeScript, deployed on Vercel
- Public Solana RPC: `getTransaction` (jsonParsed), `simulateTransaction`
- Built with [solana.new](https://solana.new) (superstack) + Claude Code

## MVP scope (3 weeks)

- [ ] Week 1 — parse + render the instruction tree for any signature, failing step highlighted
- [ ] Week 2 — knowledge base v1 (top 50 Anchor + native errors with fixes), IDL decoding, log parser, basic pre-send simulation
- [ ] Week 3 — shareable trace pages, tested against 20 real failed transactions, demo video, launch

## Roadmap

- KB expanded to 150+ errors incl. top DeFi programs, fixes linked to docs
- Wallet-simulation mode — diagnose a transaction *before* sending it, as an embeddable widget
- Public API + usage dashboard, MIT licensed

---

Built for the Solana ecosystem. Entering the Colosseum hackathon (Sep 28 – Nov 2, 2026).
