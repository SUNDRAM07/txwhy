"""
The send loop for solana-py / solders users, plus local verification of a repair. Sync and async:

    from solana.rpc.async_api import AsyncClient
    from txwhy.solana import async_send_with_repair, async_verify_repair

    signature = await async_send_with_repair(client, tx, keypair)
    check = await async_verify_repair(client, original_bytes, repaired_bytes)   # no call to TxWhy

With a sync `solana.rpc.api.Client` (solana-py releases that ship one) use `send_with_repair` and
`verify_repair`. Legacy and v0 transactions are supported (v0 lookup tables are expanded through
the RPC you pass). Version 1 transactions: call `txwhy.repair(transaction=...)` and verify with your
own decoder.
"""

from __future__ import annotations

import base64
import inspect
import json
from typing import Any, Awaitable, Callable, Optional

from . import DEFAULT_ENDPOINT, TxWhyError, repair
from .shapes import AccountMeta, Instruction
from .verify import Verification, verify_instructions

try:  # optional dependency: only needed for this module
    from solders.keypair import Keypair
    from solders.message import MessageV0
    from solders.pubkey import Pubkey
    from solders.transaction import VersionedTransaction
except ImportError as e:  # pragma: no cover
    raise ImportError("txwhy.solana needs solders and solana: pip install 'txwhy[solana]'") from e

TxLike = "VersionedTransaction | bytes | str"


def _to_tx(tx: Any) -> VersionedTransaction:
    if isinstance(tx, VersionedTransaction):
        return tx
    raw = base64.b64decode(tx) if isinstance(tx, str) else bytes(tx)
    return VersionedTransaction.from_bytes(raw)


def lookup_tables_needed(tx: Any) -> list[Pubkey]:
    """The address lookup tables a v0 transaction references (empty for legacy)."""
    msg = _to_tx(tx).message
    return [l.account_key for l in msg.address_table_lookups] if isinstance(msg, MessageV0) else []


def decompile_with(tx: Any, tables: dict[str, bytes]) -> tuple[str, list[Instruction]]:
    """(fee payer, instructions) with every account resolved, given the raw data of each lookup table."""
    msg = _to_tx(tx).message
    header = msg.header
    static = list(msg.account_keys)
    loaded_w: list[Pubkey] = []
    loaded_r: list[Pubkey] = []
    if isinstance(msg, MessageV0):
        for lookup in msg.address_table_lookups:
            data = tables.get(str(lookup.account_key))
            if data is None:
                raise TxWhyError(f"Address lookup table {lookup.account_key} no longer exists, so this transaction cannot be verified.")
            keys = [Pubkey.from_bytes(data[i : i + 32]) for i in range(56, len(data) - 31, 32)]  # 56-byte header, then keys
            loaded_w += [keys[i] for i in lookup.writable_indexes]
            loaded_r += [keys[i] for i in lookup.readonly_indexes]
    all_keys = static + loaded_w + loaded_r
    n_static, n_signers = len(static), header.num_required_signatures

    def meta(index: int) -> AccountMeta:
        key = str(all_keys[index])
        if index < n_static:
            if index < n_signers:
                return AccountMeta(key, True, index < n_signers - header.num_readonly_signed_accounts)
            return AccountMeta(key, False, index < n_static - header.num_readonly_unsigned_accounts)
        return AccountMeta(key, False, index < n_static + len(loaded_w))

    instructions = [
        Instruction(program_id=str(all_keys[ix.program_id_index]), accounts=[meta(i) for i in ix.accounts], data=bytes(ix.data))
        for ix in msg.instructions
    ]
    return str(static[0]), instructions


def _account_bytes(value: Any) -> Optional[bytes]:
    return None if value is None else bytes(value.data)


def _fetch_tables_sync(client: Any, tx: Any) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for key in lookup_tables_needed(tx):
        data = _account_bytes(client.get_account_info(key).value)
        if data is not None:
            out[str(key)] = data
    return out


async def _fetch_tables_async(client: Any, tx: Any) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    for key in lookup_tables_needed(tx):
        data = _account_bytes((await client.get_account_info(key)).value)
        if data is not None:
            out[str(key)] = data
    return out


def decompile(client: Any, tx: Any) -> tuple[str, list[Instruction]]:
    return decompile_with(tx, _fetch_tables_sync(client, tx))


async def async_decompile(client: Any, tx: Any) -> tuple[str, list[Instruction]]:
    return decompile_with(tx, await _fetch_tables_async(client, tx))


def verify_repair(client: Any, original: Any, repaired: Any) -> Verification:
    """Prove locally that `repaired` only differs from `original` in the ways a repair may. TxWhy is not contacted."""
    tables = {**_fetch_tables_sync(client, original), **_fetch_tables_sync(client, repaired)}
    return _verify(original, repaired, tables)


async def async_verify_repair(client: Any, original: Any, repaired: Any) -> Verification:
    tables = {**(await _fetch_tables_async(client, original)), **(await _fetch_tables_async(client, repaired))}
    return _verify(original, repaired, tables)


def _verify(original: Any, repaired: Any, tables: dict[str, bytes]) -> Verification:
    payer_a, ixs_a = decompile_with(original, tables)
    payer_b, ixs_b = decompile_with(repaired, tables)
    return verify_instructions(payer_a, ixs_a, payer_b, ixs_b)


def _sign(current: VersionedTransaction, signer: Any) -> VersionedTransaction:
    if isinstance(signer, Keypair):
        return VersionedTransaction(current.message, [signer])
    return signer(current)


def _step(result: dict[str, Any], repairs: list[dict[str, Any]]) -> Optional[VersionedTransaction]:
    """None when the transaction is fine as built; the rebuilt transaction otherwise. Raises when there is no repair."""
    if result["status"] == "valid":
        return None
    if result["status"] != "repaired" or not result.get("repairedTransaction"):
        raise TxWhyError(result.get("summary", "not repairable"), result)
    repairs.append(result)
    return _to_tx(result["repairedTransaction"])


def send_with_repair(
    client: Any,
    transaction: Any,
    signer: Any,
    *,
    max_repairs: int = 1,
    verify: bool = True,
    endpoint: str = DEFAULT_ENDPOINT,
    on_repair: Optional[Callable[[dict[str, Any], Optional[Verification]], None]] = None,
    skip_preflight: bool = False,
) -> str:
    """
    Simulate; if it would fail, repair, verify the repair locally, then sign and send. Returns the
    signature. `signer` is a solders Keypair, or a function that signs and returns the transaction.
    Keys never leave your process: TxWhy only sees unsigned bytes. For a sync solana-py Client.
    """
    from solana.rpc.types import TxOpts

    current = _to_tx(transaction)
    repairs: list[dict[str, Any]] = []
    for attempt in range(max_repairs + 1):
        err = client.simulate_transaction(current, sig_verify=False).value.err
        if err is None:
            break
        if attempt >= max_repairs:
            raise TxWhyError(f"Still failing after {max_repairs} repair(s): {err}", repairs[-1] if repairs else None)
        rebuilt = _step(repair(transaction=bytes(current), endpoint=endpoint), repairs)
        if rebuilt is None:
            break
        verification = verify_repair(client, current, rebuilt) if verify else None
        if verification is not None and not verification.ok:
            raise TxWhyError("Refusing to sign: the repair failed local verification. " + " ".join(verification.violations), repairs[-1], verification)
        if on_repair:
            on_repair(repairs[-1], verification)
        current = rebuilt
    sent = client.send_raw_transaction(bytes(_sign(current, signer)), opts=TxOpts(skip_preflight=skip_preflight))
    return str(sent.value)


async def async_send_with_repair(
    client: Any,
    transaction: Any,
    signer: Any,
    *,
    max_repairs: int = 1,
    verify: bool = True,
    endpoint: str = DEFAULT_ENDPOINT,
    on_repair: Optional[Callable[[dict[str, Any], Optional[Verification]], Optional[Awaitable[None]]]] = None,
    skip_preflight: bool = False,
) -> str:
    """The same loop for `solana.rpc.async_api.AsyncClient`."""
    from solana.rpc.types import TxOpts

    current = _to_tx(transaction)
    repairs: list[dict[str, Any]] = []
    for attempt in range(max_repairs + 1):
        err = (await client.simulate_transaction(current, sig_verify=False)).value.err
        if err is None:
            break
        if attempt >= max_repairs:
            raise TxWhyError(f"Still failing after {max_repairs} repair(s): {err}", repairs[-1] if repairs else None)
        rebuilt = _step(repair(transaction=bytes(current), endpoint=endpoint), repairs)
        if rebuilt is None:
            break
        verification = (await async_verify_repair(client, current, rebuilt)) if verify else None
        if verification is not None and not verification.ok:
            raise TxWhyError("Refusing to sign: the repair failed local verification. " + " ".join(verification.violations), repairs[-1], verification)
        if on_repair:
            maybe = on_repair(repairs[-1], verification)
            if inspect.isawaitable(maybe):
                await maybe
        current = rebuilt
    sent = await client.send_raw_transaction(bytes(_sign(current, signer)), opts=TxOpts(skip_preflight=skip_preflight))
    return str(sent.value)


def to_json(verification: Verification) -> str:
    return json.dumps({"ok": verification.ok, "violations": verification.violations, "kept": verification.kept, "changes": [c.__dict__ for c in verification.changes]}, indent=2)
