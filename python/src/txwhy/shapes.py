"""
What a swap instruction asks for, read from the instruction alone. Pure and synchronous: no network,
no environment. The verifier depends on this module and nothing else, so it runs anywhere, offline.

Mirrors ``src/lib/swap-shape.ts`` and ``crates/txwhy-verify``; discriminators from the programs'
on-chain IDLs (Sep 2026).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

from ._b58 import b58encode


@dataclass
class AccountMeta:
    pubkey: str
    is_signer: bool = False
    is_writable: bool = False


@dataclass
class Instruction:
    program_id: str
    accounts: list[AccountMeta] = field(default_factory=list)
    data: bytes = b""


JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
METEORA_DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"
METEORA_DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"
RAYDIUM_LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj"
SYSTEM_PROGRAM = "11111111111111111111111111111111"
COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

#: A repaired limit, or a replacement quote, may never be worse for the user than this.
DIRECT_LIMIT_CAP_BPS = 2_500

Mode = Literal["ExactIn", "ExactOut"]


@dataclass(frozen=True)
class JupiterLayout:
    name: str
    mode: Mode
    user: int
    source_mint: int | None  # None: the source mint is not listed; the user's source token account is at `source`
    destination_mint: int
    amounts: int | Literal["tail"]
    source: int
    destinations: tuple[int, ...]


JUPITER_LAYOUTS: dict[str, JupiterLayout] = {
    "e517cb977ae3ad2a": JupiterLayout("route", "ExactIn", 1, None, 5, "tail", 2, (3, 4)),
    "c1209b3341d69c81": JupiterLayout("shared_accounts_route", "ExactIn", 2, 7, 8, "tail", 3, (6,)),
    "bb64facc31c4af14": JupiterLayout("route_v2", "ExactIn", 0, 3, 4, 8, 1, (2, 7)),
    "d19853937cfed8e9": JupiterLayout("shared_accounts_route_v2", "ExactIn", 1, 6, 7, 9, 2, (5,)),
    "d033ef977b2bed5c": JupiterLayout("exact_out_route", "ExactOut", 1, 5, 6, "tail", 2, (3, 4)),
    "b0d169a89a7d453e": JupiterLayout("shared_accounts_exact_out_route", "ExactOut", 2, 7, 8, "tail", 3, (6,)),
    "9d8ab85215f4f324": JupiterLayout("exact_out_route_v2", "ExactOut", 0, 3, 4, 8, 1, (2, 7)),
    "3560e5cad8bbfa18": JupiterLayout("shared_accounts_exact_out_route_v2", "ExactOut", 1, 6, 7, 9, 2, (5,)),
}


@dataclass
class SwapShape:
    instruction: str
    mode: Mode
    user: str
    output_mint: str
    amount: int
    quoted_other: int
    slippage_bps: int
    source: str
    receiver: str


def _u64(data: bytes, at: int) -> int:
    return int.from_bytes(data[at : at + 8], "little")


def read_swap_shape(ix: Instruction) -> Optional[SwapShape]:
    """The parts of a Jupiter swap that define what the user asked for."""
    if ix.program_id != JUPITER_V6 or len(ix.data) < 8:
        return None
    layout = JUPITER_LAYOUTS.get(ix.data[:8].hex())
    if layout is None:
        return None
    start = len(ix.data) - 19 if layout.amounts == "tail" else layout.amounts
    if start < 8 or start + 18 > len(ix.data):
        return None

    def at(i: int) -> str:
        return ix.accounts[i].pubkey if i < len(ix.accounts) else ""

    user, output_mint = at(layout.user), at(layout.destination_mint)
    if not user or not output_mint:
        return None
    receivers = [a for a in (at(i) for i in layout.destinations) if a and a != JUPITER_V6]
    return SwapShape(
        instruction=layout.name,
        mode=layout.mode,
        user=user,
        output_mint=output_mint,
        amount=_u64(ix.data, start),
        quoted_other=_u64(ix.data, start + 8),
        slippage_bps=int.from_bytes(ix.data[start + 16 : start + 18], "little"),
        source=at(layout.source),
        receiver=receivers[-1] if receivers else "",
    )


def allowed_quote_move(mode: str, before: int, after: int) -> bool:
    """A replacement quote may move at most the cap against the user. A zero original constrains nothing."""
    if before == 0:
        return True
    cap = before * DIRECT_LIMIT_CAP_BPS // 10_000
    return after >= before - cap if mode == "ExactIn" else after <= before + cap


@dataclass(frozen=True)
class DirectLayout:
    program: str
    name: str
    fixed: Literal["tokens_out", "quote_in", "tokens_in"]
    limit: Literal["max_in", "min_out"]
    tag_length: int = 8
    limit_first: bool = False
    mode_byte: bool = False
    user_in: int | None = None
    user_out: int | None = None


DIRECT_LAYOUTS: dict[str, dict[str, DirectLayout]] = {
    PUMP_FUN: {
        "66063d1201daebea": DirectLayout("Pump.fun", "buy", "tokens_out", "max_in"),
        "b817ee6167c5d33d": DirectLayout("Pump.fun", "buy_v2", "tokens_out", "max_in"),
        "38fc74089edfcd5f": DirectLayout("Pump.fun", "buy_exact_sol_in", "quote_in", "min_out"),
        "c2ab1c46684d5b2f": DirectLayout("Pump.fun", "buy_exact_quote_in_v2", "quote_in", "min_out"),
        "33e685a4017f83ad": DirectLayout("Pump.fun", "sell", "tokens_in", "min_out", user_in=5),
        "5df6823ce7e940b2": DirectLayout("Pump.fun", "sell_v2", "tokens_in", "min_out"),
    },
    PUMP_SWAP: {
        "66063d1201daebea": DirectLayout("PumpSwap", "buy", "tokens_out", "max_in", user_in=6),
        "c62e1552b4d9e870": DirectLayout("PumpSwap", "buy_exact_quote_in", "quote_in", "min_out", user_in=6),
        "33e685a4017f83ad": DirectLayout("PumpSwap", "sell", "tokens_in", "min_out", user_in=5),
    },
    RAYDIUM_V4: {
        "09": DirectLayout("Raydium AMM v4", "swap_base_in", "tokens_in", "min_out", tag_length=1),
        "0b": DirectLayout("Raydium AMM v4", "swap_base_out", "tokens_out", "max_in", tag_length=1),
        "10": DirectLayout("Raydium AMM v4", "swap_base_in", "tokens_in", "min_out", tag_length=1),
        "11": DirectLayout("Raydium AMM v4", "swap_base_out", "tokens_out", "max_in", tag_length=1, limit_first=True),
    },
    RAYDIUM_LAUNCHLAB: {
        "faea0d7bd59c13ec": DirectLayout("Raydium LaunchLab", "buy_exact_in", "quote_in", "min_out", user_in=6, user_out=5),
        "9527de9bd37c981a": DirectLayout("Raydium LaunchLab", "sell_exact_in", "tokens_in", "min_out", user_in=5, user_out=6),
        "18d3742869039938": DirectLayout("Raydium LaunchLab", "buy_exact_out", "tokens_out", "max_in", user_in=6, user_out=5),
        "5fc8472208090ba6": DirectLayout("Raydium LaunchLab", "sell_exact_out", "tokens_out", "max_in", user_in=5, user_out=6),
    },
    METEORA_DBC: {
        "f8c69e91e17587c8": DirectLayout("Meteora DBC", "swap", "tokens_in", "min_out", user_in=3, user_out=4),
        "414b3f4ceb5b5b88": DirectLayout("Meteora DBC", "swap2", "tokens_in", "min_out", mode_byte=True, user_in=3, user_out=4),
    },
    METEORA_DAMM_V2: {
        "f8c69e91e17587c8": DirectLayout("Meteora DAMM v2", "swap", "tokens_in", "min_out", user_in=2, user_out=3),
        "414b3f4ceb5b5b88": DirectLayout("Meteora DAMM v2", "swap2", "tokens_in", "min_out", mode_byte=True, user_in=2, user_out=3),
    },
}


@dataclass
class DirectSwapShape:
    program: str
    name: str
    limit: str
    discriminator: str
    amount: int
    limit_value: int
    accounts: list[str]
    tail: bytes
    user_in: str | None


def read_direct_swap_shape(ix: Instruction) -> Optional[DirectSwapShape]:
    """What a direct Pump.fun / PumpSwap / Raydium / Meteora swap asks for, from the instruction alone."""
    layouts = DIRECT_LAYOUTS.get(ix.program_id)
    if not layouts:
        return None
    tag_length = next(iter(layouts.values())).tag_length
    if len(ix.data) < tag_length + 16:
        return None
    discriminator = ix.data[:tag_length].hex()
    layout = layouts.get(discriminator)
    if layout is None:
        return None
    name, limit = layout.name, layout.limit
    if layout.mode_byte:
        if len(ix.data) < tag_length + 17:
            return None
        mode = ix.data[tag_length + 16]
        if mode == 2:
            name, limit = f"{layout.name} (exact out)", "max_in"
        elif mode not in (0, 1):
            return None
    amount_at = tag_length + 8 if layout.limit_first else tag_length
    limit_at = tag_length if layout.limit_first else tag_length + 8
    user_in = ix.accounts[layout.user_in].pubkey if layout.user_in is not None and layout.user_in < len(ix.accounts) else None
    return DirectSwapShape(
        program=layout.program,
        name=name,
        limit=limit,
        discriminator=discriminator,
        amount=_u64(ix.data, amount_at),
        limit_value=_u64(ix.data, limit_at),
        accounts=[f"{a.pubkey}:{'s' if a.is_signer else ''}{'w' if a.is_writable else ''}" for a in ix.accounts],
        tail=ix.data[tag_length + 16 :],
        user_in=user_in,
    )


def allowed_direct_limit_change(before: DirectSwapShape, after: DirectSwapShape) -> str | None:
    """None when `after` is the same swap with only its limit moved within the cap; otherwise what changed."""
    if before.discriminator != after.discriminator or before.program != after.program:
        return "the instruction kind"
    if before.amount != after.amount:
        return "the amount"
    if before.tail != after.tail:
        return "the instruction flags"
    if before.accounts != after.accounts:
        return "the accounts"
    cap = before.limit_value * DIRECT_LIMIT_CAP_BPS // 10_000
    if before.limit == "max_in":
        if after.limit_value > before.limit_value + cap:
            return f"the maximum cost, by more than {DIRECT_LIMIT_CAP_BPS // 100}%"
    elif after.limit_value < before.limit_value - cap:
        return f"the minimum received, by more than {DIRECT_LIMIT_CAP_BPS // 100}%"
    return None


def read_system_transfer(ix: Instruction) -> tuple[str, str, int] | None:
    """A System Program transfer (tag 2): (from, to, lamports)."""
    if ix.program_id != SYSTEM_PROGRAM or len(ix.accounts) < 2 or len(ix.data) != 12:
        return None
    if int.from_bytes(ix.data[:4], "little") != 2:
        return None
    return ix.accounts[0].pubkey, ix.accounts[1].pubkey, _u64(ix.data, 4)


def allowed_wrap_raise(wrap_before: int, wrap_after: int, limit_before: int, limit_after: int) -> bool:
    """A wrap into an exact-out swap's own input account may rise by no more than the maximum rose, and no more than the cap of itself."""
    if wrap_after <= wrap_before or limit_after <= limit_before:
        return False
    raise_ = wrap_after - wrap_before
    return raise_ <= limit_after - limit_before and raise_ <= wrap_before * DIRECT_LIMIT_CAP_BPS // 10_000


def is_compute_budget(ix: Instruction) -> bool:
    return ix.program_id == COMPUTE_BUDGET


def is_idempotent_ata_create(ix: Instruction) -> bool:
    """Associated Token Account "CreateIdempotent" (tag 1): harmless if the account already exists."""
    return ix.program_id == ATA_PROGRAM and len(ix.data) >= 1 and ix.data[0] == 1


def pubkey_from_bytes(raw: bytes) -> str:
    return b58encode(raw)
