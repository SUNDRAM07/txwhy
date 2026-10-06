"""The rules, attacked the same ways as scripts/test-verify.ts and the Rust crate's unit tests."""

from txwhy import AccountMeta, Instruction, verify_instructions
from txwhy.shapes import (
    JUPITER_V6,
    METEORA_DAMM_V2,
    METEORA_DBC,
    PUMP_SWAP,
    RAYDIUM_LAUNCHLAB,
    RAYDIUM_V4,
    SYSTEM_PROGRAM,
    read_direct_swap_shape,
    read_swap_shape,
)

PAYER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9"
SOURCE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
DEST = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
MINT = "So11111111111111111111111111111111111111112"
OTHER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"
THIEF = "FJoSWhcquvWHzvnM2GXsnU1svkNBCLDfcY7NnD9oWTF5"
PROG = "11111111111111111111111111111111"


def acct(k, s=False, w=False):
    return AccountMeta(k, s, w)


def plain(program, data):
    return Instruction(program, [acct(PAYER, True, True)], bytes(data))


def budget(units):
    return Instruction("ComputeBudget111111111111111111111111111111", [], bytes([2]) + units.to_bytes(4, "little"))


def jup(amount=1000, quoted=0, slippage=50, receiver=DEST, route=b"\x01", user=PAYER, source=SOURCE):
    data = bytes.fromhex("bb64facc31c4af14") + amount.to_bytes(8, "little") + quoted.to_bytes(8, "little") + slippage.to_bytes(2, "little") + b"\x00" + route
    accounts = [acct(user, True, True), acct(source, False, True), acct(JUPITER_V6), acct(PROG), acct(MINT), acct(PROG), acct(PROG), acct(receiver, False, True), acct(OTHER), acct(OTHER, False, True)]
    return Instruction(JUPITER_V6, accounts, data)


def pump_buy(amount, max_cost, tail=b"\x00"):
    data = bytes.fromhex("66063d1201daebea") + amount.to_bytes(8, "little") + max_cost.to_bytes(8, "little") + tail
    return Instruction(PUMP_SWAP, [acct(OTHER, False, True), acct(PAYER, True, True), acct(MINT)], data)


def raydium_base_out(amount_out, max_in):
    data = bytes([0x11]) + max_in.to_bytes(8, "little") + amount_out.to_bytes(8, "little")
    return Instruction(RAYDIUM_V4, [acct(PROG), acct(OTHER, False, True), acct(PAYER, True, True)], data)


def meteora(program, amount, limit, mode):
    data = bytes.fromhex("414b3f4ceb5b5b88") + amount.to_bytes(8, "little") + limit.to_bytes(8, "little") + bytes([mode])
    return Instruction(program, [acct(PROG), acct(OTHER, False, True), acct(SOURCE, False, True), acct(DEST, False, True), acct(PAYER, True, True)], data)


def wrap(to, lamports):
    return Instruction(SYSTEM_PROGRAM, [acct(PAYER, True, True), acct(to, False, True)], (2).to_bytes(4, "little") + lamports.to_bytes(8, "little"))


def run(original, repaired):
    return verify_instructions(PAYER, original, PAYER, repaired)


def test_budget_only_changes_are_fine():
    v = run([budget(100), plain(PROG, [1])], [budget(180_000), plain(PROG, [1])])
    assert v.ok and v.kept == 1 and [c.kind for c in v.changes] == ["compute_budget"]


def test_payer_and_signer_changes_are_refused():
    assert not verify_instructions(PAYER, [plain(PROG, [1])], THIEF, [plain(PROG, [1])]).ok
    extra = Instruction(PROG, [acct(THIEF, True, True)], b"\x01")
    assert "new required signer" in run([plain(PROG, [1])], [plain(PROG, [1]), extra]).violations[0]


def test_any_other_instruction_change_is_refused():
    assert not run([plain(PROG, [1]), plain(OTHER, [2])], [plain(PROG, [1]), plain(OTHER, [3])]).ok
    assert "missing" in run([plain(PROG, [1]), plain(OTHER, [2])], [plain(PROG, [1])]).violations[0]
    assert "not in the original" in run([plain(PROG, [1])], [plain(PROG, [1]), plain(OTHER, [2])]).violations[0]


def test_jupiter_requote_same_trade_ok_and_attacks_refused():
    v = run([jup(quoted=5_000_000)], [jup(quoted=4_700_000, route=b"\x09")])
    assert v.ok and v.changes[0].kind == "swap_replaced"
    assert not run([jup()], [jup(amount=2000)]).ok
    assert not run([jup()], [jup(slippage=5000)]).ok
    assert not run([jup()], [jup(receiver=THIEF)]).ok
    assert not run([jup()], [jup(user=THIEF)]).ok
    assert not run([jup()], [jup(source=THIEF)]).ok
    assert "quoted output, by more than 25%" in run([jup(quoted=10_000)], [jup(quoted=7_499)]).violations[0]
    assert run([jup(quoted=10_000)], [jup(quoted=7_500)]).ok


def test_direct_limit_moves_within_the_cap():
    v = run([pump_buy(1000, 10_000)], [pump_buy(1000, 12_500)])
    assert v.ok and v.changes[0].kind == "swap_limit_moved"
    assert "maximum cost, by more than 25%" in run([pump_buy(1000, 10_000)], [pump_buy(1000, 12_501)]).violations[0]
    assert "the amount" in run([pump_buy(1000, 10_000)], [pump_buy(1001, 10_000)]).violations[0]
    assert "the instruction flags" in run([pump_buy(1000, 10_000)], [pump_buy(1000, 10_000, tail=b"\x01")]).violations[0]
    assert run([raydium_base_out(5_000, 100_000)], [raydium_base_out(5_000, 125_000)]).ok
    assert not run([raydium_base_out(5_000, 100_000)], [raydium_base_out(5_000, 125_001)]).ok


def test_meteora_modes_and_launchlab():
    assert run([meteora(METEORA_DBC, 1000, 10_000, 0)], [meteora(METEORA_DBC, 1000, 7_500, 0)]).ok
    assert not run([meteora(METEORA_DBC, 1000, 10_000, 0)], [meteora(METEORA_DBC, 1000, 7_499, 0)]).ok
    assert run([meteora(METEORA_DAMM_V2, 1000, 10_000, 2)], [meteora(METEORA_DAMM_V2, 1000, 12_500, 2)]).ok
    assert not run([meteora(METEORA_DAMM_V2, 1000, 10_000, 0)], [meteora(METEORA_DAMM_V2, 1000, 10_000, 2)]).ok
    assert read_direct_swap_shape(meteora(METEORA_DBC, 1, 1, 3)) is None
    sell = Instruction(RAYDIUM_LAUNCHLAB, [acct(PAYER, True, True)], bytes.fromhex("9527de9bd37c981a") + (1000).to_bytes(8, "little") + (10_000).to_bytes(8, "little") + bytes(8))
    sell2 = Instruction(RAYDIUM_LAUNCHLAB, [acct(PAYER, True, True)], bytes.fromhex("9527de9bd37c981a") + (1000).to_bytes(8, "little") + (7_500).to_bytes(8, "little") + bytes(8))
    assert run([sell], [sell2]).ok


def test_wrap_may_rise_only_with_the_maximum_it_funds():
    before = [wrap(SOURCE, 10_000), meteora(METEORA_DAMM_V2, 500, 10_000, 2)]
    v = run(before, [wrap(SOURCE, 11_000), meteora(METEORA_DAMM_V2, 500, 11_000, 2)])
    assert v.ok and v.changes[0].kind == "wrap_raised"
    assert not run(before, [wrap(SOURCE, 11_001), meteora(METEORA_DAMM_V2, 500, 11_000, 2)]).ok
    assert not run(before, [wrap(SOURCE, 11_000), meteora(METEORA_DAMM_V2, 500, 10_000, 2)]).ok
    small = [wrap(SOURCE, 1_000), meteora(METEORA_DAMM_V2, 500, 10_000, 2)]
    assert not run(small, [wrap(SOURCE, 1_251), meteora(METEORA_DAMM_V2, 500, 12_500, 2)]).ok
    other = [wrap(OTHER, 10_000), meteora(METEORA_DAMM_V2, 500, 10_000, 2)]
    assert not run(other, [wrap(OTHER, 11_000), meteora(METEORA_DAMM_V2, 500, 11_000, 2)]).ok
    assert not run([wrap(SOURCE, 10_000), plain(PROG, [1])], [wrap(SOURCE, 11_000), plain(PROG, [1])]).ok


def test_shapes_read_correctly():
    s = read_swap_shape(jup(amount=42, slippage=30))
    assert (s.amount, s.slippage_bps, s.receiver, s.mode) == (42, 30, DEST, "ExactIn")
    d = read_direct_swap_shape(pump_buy(7, 9))
    assert (d.amount, d.limit_value, d.limit, d.name) == (7, 9, "max_in", "buy")
    assert read_direct_swap_shape(plain(PROG, [1])) is None
