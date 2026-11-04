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

## Meteora DBC (`dbc-failures.ts`)

```bash
npx tsx scripts/_dbc-live-pool.ts                 # live pools still trading, with the room left before graduation
SOLANA_RPC_URL=http://127.0.0.1:8899 npx tsx surfpool-scenarios/dbc-failures.ts <pool address> [payer]
```

Surfpool has no DBC override template yet, so the harness writes the same fields the proposed template would write, through `surfnet_setAccount` on the pool's bytes at the offsets `dbc-layout.ts` computes from the IDL. The probe is a real 0.05 SOL buy built by Meteora's SDK against the live pool.

| Scenario | Fields written | Engine verdict, Nov 4 2026, surfpool 1.7.0, pool 4j8f6fzQ… |
|---|---|---|
| baseline | none | `valid` |
| graduated | `quote_reserve` = config's `migration_quote_threshold` | `not_repairable`, "Launch pool already graduated", naming the DAMM v2 pool |
| nearly full | `sqrt_price` just under `migration_sqrt_price`, `quote_reserve` just under the threshold | `not_repairable`, "Launch pool nearly full", 0.005 SOL of room against a 0.05 SOL buy |
| stale quote | `sqrt_price` up (under the curve's end), `quote_reserve` up (under the threshold) | `repaired` with `swap_quote`, verified |

Two findings from the run, now in the template's docs: moving `quote_reserve` alone to just under the threshold leaves the buy valid, because the swap math walks `sqrt_price` and `quote_reserve` is bookkeeping read only by the graduation check; and a pool 90% of the way to graduation has little price left before `migration_sqrt_price`, so a 15% "price jump" overshoots the curve's end and reads as out of curve, not as a stale quote.

## The template contribution

`meteora-dbc/overrides.yaml` and `meteora-dbc/idl.json` are the proposed Surfpool templates (`meteora-dbc-pool-custom` for the pool, `meteora-dbc-config-custom` for the graduation thresholds), in the format of `crates/core/src/scenarios/protocols/pump/v1/overrides.yaml`; the pull request to solana-foundation/surfpool adds them under `protocols/meteora/dbc/v1/` with the registry wiring, a README and a registry test. Raydium LaunchLab still has none.
