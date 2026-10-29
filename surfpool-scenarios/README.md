# Failure scenarios on a Surfpool surfnet

Real failure modes, reproduced on demand against a local mainnet fork, with the TxWhy engine as the test oracle. Each scenario overrides a live account with one of Surfpool's built-in override templates, builds a real transaction against the state as it was, and asks the engine what it makes of the transaction now. The verdict is the assertion.

## Pump.fun (`pump-failures.ts`)

```bash
surfpool start                                   # in another terminal; the surfnet fetches mainnet state on demand
SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/pump-failures.ts <pump mint> [payer]
```

Pick a mint whose curve has not completed (`node scripts/_pump-live-mint.mjs` prints one). The payer defaults to the public demo wallet.

| Scenario | Override (template `pump-bonding-curve-custom`) | Engine verdict, Oct 28 2026, surfpool 1.6.1 |
|---|---|---|
| baseline | none | `valid`: the 0.1 SOL buy at the live price executes |
| price jumped 15% | quote reserves up 15% with the constant product kept, built on a fresh mainnet read | `repaired`: the stale maximum moved to the new price, every other instruction byte for byte, verified |
| curve complete | `complete: true`, `real_token_reserves: 0` | `not_repairable`, "Launch curve complete", naming the canonical PumpSwap pool |
| nearly sold out | live reserves, `real_token_reserves: 1000000` | `not_repairable`, "Launch curve nearly sold out", with the tokens left and the amount asked (this verdict was written because the scenario first returned the generic refusal) |

The curve is restored to its live values at the end.

## What the template does and does not accept (measured)

- Values must be JSON numbers. Decimal strings are silently ignored on u64 fields: the call answers `null` with no error and the account does not change. Keep values under 2^53; bonding-curve fields are.
- `fetchBeforeUse: true` re-reads the account from mainnet before applying the override, so a live curve moves under you between your read and the override. Use it once, for the first override, then build later overrides on the surfnet state with `fetchBeforeUse: false`.
- Booleans apply as JSON booleans (`complete: true` works).
- An override takes effect one slot after registration; the surfnet's default slot is 250 ms.

## Next

Meteora DBC and Raydium LaunchLab have no override template in Surfpool yet, so their "launch pool nearly full" and "graduated" scenarios need a template contribution (`idl.json` plus `overrides.yaml` under `crates/core/src/scenarios/protocols/`, wired in `registry.rs`). The DBC on-chain IDL is saved here as `meteora-dbc/idl.json`, and `meteora-dbc/overrides.yaml` is the template file drafted in Surfpool's format (reserves, sqrt price, migration state, with the three failure modes it reproduces in its llm_context); the registry wiring is the only part that must land in their repo.
