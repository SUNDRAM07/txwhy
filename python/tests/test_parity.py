"""Replays the real original/repaired pairs shared with the Rust crate and checks the same verdicts and change kinds."""

import json
from pathlib import Path

from txwhy import AccountMeta, Instruction, verify_instructions

FIXTURES = Path(__file__).resolve().parents[2] / "crates" / "txwhy-verify" / "tests" / "fixtures.json"


def _convert(tx: dict) -> list[Instruction]:
    return [
        Instruction(ix["program_id"], [AccountMeta(a["pubkey"], a["is_signer"], a["is_writable"]) for a in ix["accounts"]], bytes.fromhex(ix["data"]))
        for ix in tx["instructions"]
    ]


def test_matches_the_typescript_verifier_on_real_repairs():
    pairs = json.loads(FIXTURES.read_text(encoding="utf-8"))
    assert pairs, "no fixtures"
    for name, pair in pairs.items():
        v = verify_instructions(pair["original"]["payer"], _convert(pair["original"]), pair["repaired"]["payer"], _convert(pair["repaired"]))
        assert v.ok == pair["expected"]["ok"], (name, v.violations)
        assert v.kept == pair["expected"]["kept"], name
        assert [c.kind for c in v.changes] == [c["kind"] for c in pair["expected"]["changes"]], name


def test_a_tampered_real_repair_is_caught():
    pairs = json.loads(FIXTURES.read_text(encoding="utf-8"))
    for pair in pairs.values():
        repaired = _convert(pair["repaired"])
        # Flip one byte in the first non-compute-budget instruction.
        for ix in repaired:
            if ix.program_id != "ComputeBudget111111111111111111111111111111" and ix.data:
                ix.data = bytes([ix.data[0] ^ 0x01]) + ix.data[1:]
                break
        v = verify_instructions(pair["original"]["payer"], _convert(pair["original"]), pair["repaired"]["payer"], repaired)
        assert not v.ok
