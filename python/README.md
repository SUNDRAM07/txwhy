# txwhy

Failed Solana transaction in, working transaction out. The Python client for [TxWhy](https://txwhy.vercel.app): a repair API, a one-call send loop for solana-py, and an offline verifier that proves a repair changed only what a repair is allowed to change.

```
pip install txwhy            # the client and the verifier, no dependencies
pip install "txwhy[solana]"  # adds the solana-py / solders send loop
```

## One call in your send loop

```python
from solana.rpc.async_api import AsyncClient
from txwhy.solana import async_send_with_repair

client = AsyncClient("https://api.mainnet-beta.solana.com")
signature = await async_send_with_repair(client, tx, keypair)   # tx: solders VersionedTransaction, bytes or base64
```

With a sync `solana.rpc.api.Client`, `send_with_repair(client, tx, keypair)` does the same.

Simulates on your RPC. If it passes, sends and never contacts TxWhy. If it would fail: repair, verify locally, sign, send. Your key never leaves the process; TxWhy only sees unsigned bytes.

What it repairs: compute unit limit, expired blockhash, priority fee, loaded-data limit, a Jupiter swap that failed on slippage (fresh quote, same tokens, amount and tolerance; refused above 3% price impact or more than 25% worse than your quote), and a direct Pump.fun, PumpSwap, Raydium AMM v4, Raydium LaunchLab, Meteora DBC or Meteora DAMM v2 swap (only the limit moves, never more than 25% against you). Anything else comes back as a diagnosis with the exact cause and fix; `send_with_repair` raises `TxWhyError` whose `.result["cause"]` carries it.

## Just the repair call

```python
import txwhy

result = txwhy.repair(transaction=tx_base64)       # or txwhy.repair(signature="5xyz...")
result["status"]               # repaired | valid | needs_requote | not_repairable
result["cause"]                # {"title", "code", "cause", "fix"} or None
result["changes"]              # what moved and why
result["repairedTransaction"]  # base64, unsigned, when status is repaired or valid
```

## Just the explanation

```python
txwhy.explain(error=sim.value.err, logs=sim.value.logs)   # cause, failingProgram, repairable, next
```

## You never have to trust us

```python
from txwhy.solana import async_verify_repair   # or verify_repair with a sync Client

check = await async_verify_repair(client, original_bytes, repaired_bytes)   # no call to TxWhy
assert check.ok, check.violations
```

The rule is the same one the TypeScript SDK and the `txwhy-verify` Rust crate enforce, and all three are tested against the same real-repair fixtures: same fee payer, same signers, every non-Compute-Budget instruction byte for byte in order, at most one Jupiter swap replaced by an equivalent one (same wallet, token accounts, output token, amount, tolerance, quote no more than 25% worse), one direct swap with only its limit moved within 25%, and a wrap into an exact-out swap's own input account raised by no more than the maximum rose.

Legacy and v0 transactions are decompiled here (lookup tables through your RPC). For version 1 transactions call `txwhy.repair(transaction=...)` and verify with your own decoder.

## Pay per repair, no account (x402)

The free endpoint is rate limited. Agents that need guaranteed capacity use `https://txwhy.vercel.app/api/x402/repair`, $0.001 in USDC per repair, settled over x402; pass `endpoint=` to `repair()` with your x402 client.

MIT. Source: https://github.com/SUNDRAM07/txwhy
