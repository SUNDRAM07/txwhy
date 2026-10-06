"""
TxWhy for Python: failed Solana transaction in, working transaction out.

    import txwhy
    result = txwhy.repair(transaction=tx_base64)      # or txwhy.repair(signature="...")
    if result["status"] == "repaired":
        rebuilt = result["repairedTransaction"]        # base64, unsigned; sign it yourself

With solana-py / solders, the whole loop in one call:

    from txwhy.solana import send_with_repair
    signature = send_with_repair(client, tx, keypair)   # simulate -> repair -> verify locally -> sign -> send

The service never sees a key. `txwhy.verify` proves on your machine that a repair changed only what
a repair is allowed to change; it needs no network.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any, Optional

from .shapes import AccountMeta, Instruction
from .verify import Change, Verification, verify_instructions

__all__ = [
    "AccountMeta",
    "Change",
    "DEFAULT_ENDPOINT",
    "Instruction",
    "TxWhyError",
    "Verification",
    "explain",
    "repair",
    "verify_instructions",
]
__version__ = "0.1.0"

DEFAULT_ENDPOINT = "https://txwhy.vercel.app/api/v1/repair"


class TxWhyError(Exception):
    """Raised when the service answers with an error, refuses a repair, or a repair fails verification."""

    def __init__(self, message: str, result: Optional[dict[str, Any]] = None, verification: Optional[Verification] = None):
        super().__init__(message)
        self.result = result
        self.verification = verification


def _post(url: str, body: dict[str, Any], client: str, timeout: float) -> dict[str, Any]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-txwhy-client": client, "user-agent": f"txwhy-python/{__version__}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:  # noqa: BLE001
            payload = {}
        if e.code == 402:
            raise TxWhyError(f"Payment required: {payload.get('error', 'this endpoint is paid per repair over x402')}.") from None
        raise TxWhyError(payload.get("error") or f"TxWhy answered {e.code}.", payload if isinstance(payload, dict) else None) from None


def repair(
    *,
    transaction: Optional[str | bytes] = None,
    signature: Optional[str] = None,
    endpoint: str = DEFAULT_ENDPOINT,
    client: str = "python",
    timeout: float = 60.0,
) -> dict[str, Any]:
    """
    Diagnose and rebuild a transaction (legacy, v0 or v1), or explain one that already failed.

    Pass `transaction` as base64 text or raw bytes (signed or unsigned), or `signature` of a landed
    transaction. Returns the service's JSON: `status` is one of repaired, valid, needs_requote,
    not_repairable; `repairedTransaction` is base64 and unsigned when present; `cause` says why the
    original fails; `changes` lists what moved and why; `verification` is the server's own check.
    """
    if (transaction is None) == (signature is None):
        raise ValueError("pass exactly one of transaction= or signature=")
    if isinstance(transaction, (bytes, bytearray)):
        transaction = base64.b64encode(bytes(transaction)).decode()
    body = {"transaction": transaction.strip()} if transaction is not None else {"signature": signature}
    out = _post(endpoint, body, client, timeout)
    if "error" in out and out.get("error"):
        raise TxWhyError(str(out["error"]), out)
    return out


def explain(
    error: Any,
    logs: Optional[list[str]] = None,
    instruction: Optional[dict[str, Any]] = None,
    *,
    endpoint: str = DEFAULT_ENDPOINT,
    client: str = "python",
    timeout: float = 30.0,
) -> dict[str, Any]:
    """
    Explain a failure you already hold without sending the transaction: pass the `err` value from
    simulateTransaction / sendTransaction and the program logs. `instruction` ({"programId", "accounts",
    "data" base58}) lets wallet guards (Lighthouse) be decoded precisely.
    """
    url = endpoint[: -len("/api/v1/repair")] + "/api/v1/explain" if endpoint.endswith("/api/v1/repair") else endpoint
    body: dict[str, Any] = {"error": error}
    if logs:
        body["logs"] = logs
    if instruction:
        body["instruction"] = instruction
    out = _post(url, body, client, timeout)
    if out.get("error"):
        raise TxWhyError(str(out["error"]), out)
    return out
