# txwhy-verify

Offline verifier for [TxWhy](https://txwhy.vercel.app) transaction repairs, in Rust with no Solana dependencies.

TxWhy takes a failing Solana transaction and returns a rebuilt one that simulates clean. This crate lets you check, without trusting TxWhy and without a network call, that the rebuilt transaction only differs from yours in the ways a repair is allowed to:

- ComputeBudget instructions may be added, removed or changed.
- One Jupiter v6 swap may be replaced by an equivalent one: same wallet, same source and receiving token accounts, same output mint, same amount, same slippage tolerance. Idempotent token-account creation may precede it.
- One Pump.fun, PumpSwap or Raydium AMM v4 swap may have only its limit moved, never more than 25% against the user. Amount, accounts and flags stay identical.

Everything else must be byte for byte identical and in the same order: fee payer, signer set, every other instruction.

```rust
use txwhy_verify::{verify_instructions, Instruction, AccountMeta};

let v = verify_instructions(&original_payer, &original_ixs, &repaired_payer, &repaired_ixs);
if !v.ok {
    for reason in &v.violations { eprintln!("{reason}"); }
    return Err("repair changed more than it may");
}
```

Instructions are plain structs (base58 program id, account metas, raw data) so any transaction decoder works. The same rules run in the TypeScript verifier that ships in `@txwhy/sdk` and on the TxWhy server itself; `tests/parity.rs` replays real repairs produced by the live API and checks both reach the same verdict.

MIT. Source: https://github.com/SUNDRAM07/txwhy/tree/main/crates/txwhy-verify
