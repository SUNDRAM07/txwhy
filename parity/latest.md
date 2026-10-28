# Surfnet parity, 2026-10-28

Real landed mainnet failures, replayed through the same TxWhy engine with mainnet and with a Surfpool surfnet as the RPC, and the landed bytes simulated on both. Mainnet: solana-core 4.3.2, feature set 3383571666. Surfnet: surfpool 1.7.0, solana-core 4.3.2, feature set 3383571666.

**27 failures from 9 programs. Same verdict and same simulation outcome on 21. Diverging on 6.**

| Program | Signature | Mainnet verdict | Surfnet verdict | Simulation, mainnet | Simulation, surfnet | Classification |
|---|---|---|---|---|---|---|
| Jupiter | 4NS9XKb3xZjz… | not_repairable (SlippageToleranceExceeded) | not_repairable (SlippageToleranceExceeded) | {"InstructionError":[3,{"Custom":6001}]} | {"InstructionError":[3,{"Custom":6022}]} | state drift (21 accounts differ between the two reads) |
| Jupiter | 4rvBjZdnFmuE… | not_repairable (SlippageToleranceExceeded) | not_repairable (SlippageToleranceExceeded) | {"InstructionError":[2,{"Custom":6001}]} | {"InstructionError":[2,{"Custom":130}]} | state drift (16 accounts differ between the two reads) |
| Orca Whirlpool | 47358FyStJFc… | not_repairable (SlippageToleranceExceeded) | not_repairable (SlippageToleranceExceeded) | {"InstructionError":[4,{"Custom":6001}]} | {"InstructionError":[4,{"Custom":5464}]} | state drift (18 accounts differ between the two reads) |
| Orca Whirlpool | 3fXYXNqkiaQE… | not_repairable (SlippageToleranceExceeded) | not_repairable (SlippageToleranceExceeded) | {"InstructionError":[1,{"Custom":6001}]} | {"InstructionError":[1,{"Custom":5464}]} | state drift (18 accounts differ between the two reads) |
| Meteora DLMM | 2vJLhMHLQSbq… | not_repairable (Error 3271557125 from a private program (kyxs…wXXS)) | error | {"InstructionError":[4,{"Custom":3271557125}]} | {"InstructionError":[4,{"Custom":3271557125}]} | engine path only (same simulation; a quote or a timing difference) |
| Meteora DBC | 3vcn9ccSPkme… | repaired (InsufficientFunds) | not_repairable (Not enough tokens to transfer) | {"InstructionError":[3,{"Custom":1}]} | {"InstructionError":[3,{"Custom":1}]} | engine path only (same simulation; a quote or a timing difference) |

Runtime divergences are the ones worth filing: the surfnet held the same bytes in every account the transaction touches and still ran it differently. State divergences are balance or pool drift between the two reads and say nothing about the runtime.

Reproduce any row: `getTransaction(signature, {encoding: "base64", maxSupportedTransactionVersion: 1})` on mainnet, then `simulateTransaction` of those bytes with `sigVerify: false, replaceRecentBlockhash: true` on both RPCs.

Full signatures and verdicts: `2026-10-28.json` beside this file. Known upstream: solana-foundation/surfpool #870 (rent parameters behind SIMD-0437; fix in #873).
