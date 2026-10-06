"""
Prove, with no network access, that a repaired transaction only differs from the original in the
ways a repair is allowed to:

- same fee payer, same set of signers;
- every instruction that is not Compute Budget is byte for byte identical, in the same order;
- at most one Jupiter swap replaced by one for the same wallet, same source and receiving token
  accounts, same output token, same amount, same slippage tolerance, and a quote no more than 25%
  worse (idempotent token-account creation may precede it);
- one direct Pump.fun / PumpSwap / Raydium / Meteora swap may have only its limit moved, never more
  than 25% against the user, with amount, accounts and flags identical;
- a SOL transfer that wraps funds into an exact-out swap's own input account may rise, by no more
  than the maximum rose and no more than 25% of itself.

Mirrors ``src/lib/verify.ts`` and ``crates/txwhy-verify``; the three share one fixture set.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .shapes import (
    DIRECT_LAYOUTS,
    JUPITER_V6,
    Instruction,
    allowed_direct_limit_change,
    allowed_quote_move,
    allowed_wrap_raise,
    is_compute_budget,
    is_idempotent_ata_create,
    read_direct_swap_shape,
    read_swap_shape,
    read_system_transfer,
)


@dataclass
class Change:
    kind: str  # compute_budget | swap_replaced | token_account_setup | swap_limit_moved | wrap_raised
    program: str
    detail: str


@dataclass
class Verification:
    ok: bool
    violations: list[str] = field(default_factory=list)
    kept: int = 0
    changes: list[Change] = field(default_factory=list)


def _same(a: Instruction, b: Instruction) -> bool:
    return (
        a.program_id == b.program_id
        and len(a.accounts) == len(b.accounts)
        and all(x.pubkey == y.pubkey for x, y in zip(a.accounts, b.accounts))
        and a.data == b.data
    )


def _signers(payer: str, instructions: list[Instruction]) -> set[str]:
    out = {payer}
    for ix in instructions:
        for a in ix.accounts:
            if a.is_signer:
                out.add(a.pubkey)
    return out


def _describe_budget(ix: Instruction) -> str:
    d = ix.data
    tag = d[0] if d else -1
    if tag == 2 and len(d) >= 5:
        return f"compute unit limit {int.from_bytes(d[1:5], 'little'):,}"
    if tag == 3 and len(d) >= 9:
        return f"priority fee {int.from_bytes(d[1:9], 'little')} micro-lamports per compute unit"
    if tag == 4 and len(d) >= 5:
        return f"loaded account data limit {int.from_bytes(d[1:5], 'little'):,} bytes"
    if tag == 1 and len(d) >= 5:
        return f"heap frame {int.from_bytes(d[1:5], 'little'):,} bytes"
    return "compute budget setting"


def verify_instructions(original_payer: str, original: list[Instruction], repaired_payer: str, repaired: list[Instruction]) -> Verification:
    """Verify a repair without trusting the service that made it."""
    violations: list[str] = []
    changes: list[Change] = []
    kept = 0

    if original_payer != repaired_payer:
        violations.append(f"The fee payer changed from {original_payer} to {repaired_payer}.")
    before, after = _signers(original_payer, original), _signers(repaired_payer, repaired)
    for s in sorted(after - before):
        violations.append(f"A new required signer was added: {s}.")
    for s in sorted(before - after):
        violations.append(f"A required signer was removed: {s}.")
    for ix in repaired:
        if is_compute_budget(ix):
            changes.append(Change("compute_budget", "Compute Budget", _describe_budget(ix)))

    a = [ix for ix in original if not is_compute_budget(ix)]
    b = [ix for ix in repaired if not is_compute_budget(ix)]
    i = j = 0
    pending_wrap: tuple[str, int, int] | None = None  # (to, before, after)
    while i < len(a) and j < len(b):
        if _same(a[i], b[j]):
            kept += 1
            i += 1
            j += 1
            continue
        if pending_wrap is None:
            was_t, now_t = read_system_transfer(a[i]), read_system_transfer(b[j])
            if was_t and now_t and was_t[0] == now_t[0] and was_t[1] == now_t[1] and now_t[2] > was_t[2]:
                pending_wrap = (was_t[1], was_t[2], now_t[2])
                i += 1
                j += 1
                continue
        if a[i].program_id == JUPITER_V6:
            k = j
            while k < len(b) and is_idempotent_ata_create(b[k]):
                k += 1
            was = read_swap_shape(a[i])
            now = read_swap_shape(b[k]) if k < len(b) and b[k].program_id == JUPITER_V6 else None
            if was is None or now is None:
                violations.append(f"Instruction {i + 1} (a Jupiter swap) was changed into something that is not an equivalent swap.")
                break
            mismatches = [
                m
                for cond, m in (
                    (was.user != now.user, "the swapping wallet"),
                    (was.output_mint != now.output_mint, "the output token"),
                    (was.mode != now.mode, "the swap mode"),
                    (was.amount != now.amount, "the amount"),
                    (was.slippage_bps != now.slippage_bps, "the slippage tolerance"),
                    (
                        not allowed_quote_move(was.mode, was.quoted_other, now.quoted_other),
                        f"the quoted {'output' if was.mode == 'ExactIn' else 'cost'}, by more than 25% against the user",
                    ),
                    (was.source != now.source, "the token account the input is taken from"),
                    (not was.receiver or was.receiver != now.receiver, "the token account that receives the output"),
                )
                if cond
            ]
            if mismatches:
                violations.append(f"The replacement swap changes {', '.join(mismatches)}.")
                break
            for _ in range(j, k):
                changes.append(Change("token_account_setup", "Associated Token Account", "create token account if missing (idempotent)"))
            changes.append(Change("swap_replaced", "Jupiter Aggregator v6", f"same wallet, output token, amount and {was.slippage_bps / 100:.2f}% tolerance; new route and quote"))
            i += 1
            j = k + 1
            continue
        if a[i].program_id in DIRECT_LAYOUTS and b[j].program_id == a[i].program_id:
            was_d, now_d = read_direct_swap_shape(a[i]), read_direct_swap_shape(b[j])
            reason = allowed_direct_limit_change(was_d, now_d) if was_d and now_d else "the swap"
            if reason is not None or was_d is None or now_d is None:
                violations.append(f"The replacement {was_d.program if was_d else 'swap'} instruction changes {reason or 'the swap'}.")
                break
            if pending_wrap is not None:
                to, w_before, w_after = pending_wrap
                justified = was_d.limit == "max_in" and was_d.user_in == to and allowed_wrap_raise(w_before, w_after, was_d.limit_value, now_d.limit_value)
                if not justified:
                    violations.append(f"A SOL transfer to {to} was raised from {w_before} to {w_after} lamports, which the limit move of this swap does not justify.")
                    break
                changes.append(Change("wrap_raised", "System Program", f"SOL wrapped into the input account of the swap {w_before} -> {w_after} lamports, no more than the maximum cost rose"))
                pending_wrap = None
            side = "maximum cost" if was_d.limit == "max_in" else "minimum received"
            changes.append(Change("swap_limit_moved", was_d.program, f"same {was_d.name}, same amount and accounts; {side} {was_d.limit_value} -> {now_d.limit_value}"))
            i += 1
            j += 1
            continue
        violations.append(f"Instruction {i + 1} (program {a[i].program_id}) is not the same in the repaired transaction.")
        break

    if not violations and pending_wrap is not None:
        to, w_before, w_after = pending_wrap
        violations.append(f"A SOL transfer to {to} was raised from {w_before} to {w_after} lamports with no swap limit move to justify it.")
    if not violations:
        if i < len(a):
            violations.append(f"{len(a) - i} original instruction(s) are missing from the repaired transaction.")
        if j < len(b):
            violations.append(f"The repaired transaction contains {len(b) - j} instruction(s) that were not in the original (first: program {b[j].program_id}).")
    return Verification(ok=not violations, violations=violations, kept=kept, changes=changes)
