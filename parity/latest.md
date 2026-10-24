# Surfnet parity, 2026-10-24

Real landed mainnet failures, replayed through the same TxWhy engine with mainnet and with a Surfpool surfnet as the RPC, and the landed bytes simulated on both. Mainnet: solana-core 4.3.2, feature set 3383571666. Surfnet: surfpool 1.6.1, solana-core 4.2.1, feature set 565236538.

**27 failures from 9 programs. Same verdict and same simulation outcome on 19. Diverging on 8.**

| Program | Signature | Mainnet verdict | Surfnet verdict | Simulation, mainnet | Simulation, surfnet | Classification |
|---|---|---|---|---|---|---|
| Jupiter | 3p6BnoTF72Gb… | not_repairable (Obsidian error 5 (0x5)) | not_repairable (Obsidian error 5 (0x5)) | {"InstructionError":[2,{"Custom":5}]} | {"InstructionError":[2,{"Custom":5464}]} | state drift (12 accounts differ between the two reads) |
| Jupiter | 2BhqgKcpYKbk… | not_repairable (SlippageToleranceExceeded) | not_repairable (SlippageToleranceExceeded) | {"InstructionError":[2,{"Custom":6001}]} | {"InstructionError":[2,{"Custom":6004}]} | state drift (11 accounts differ between the two reads) |
| Raydium AMM | 4A9ySL1VZhWT… | not_repairable (Not enough tokens to transfer) | not_repairable (InsufficientFunds) | {"InstructionError":[5,{"Custom":1}]} | {"InstructionError":[2,{"Custom":2005}]} | runtime, rent parameters (#870): the surfnet fails a rent check mainnet passes |
| Orca Whirlpool | 3UHP45DFkViX… | needs_requote (SlippageToleranceExceeded) | needs_requote (SlippageToleranceExceeded) | {"InstructionError":[1,{"Custom":6001}]} | {"InstructionError":[1,{"Custom":21}]} | state drift (19 accounts differ between the two reads) |
| Pump.fun | 4YwLg6MNAxFK… | not_repairable (Error 11 from a private program (261e…XWW1)) | not_repairable (Error 11 from a private program (261e…XWW1)) | {"InstructionError":[0,{"Custom":21}]} | {"InstructionError":[0,{"Custom":11}]} | state drift (4 accounts differ between the two reads) |
| Pump.fun | 4d9yLc9wiqcM… | not_repairable (Error 11 from a private program (261e…XWW1)) | not_repairable (Error 11 from a private program (261e…XWW1)) | {"InstructionError":[0,{"Custom":21}]} | {"InstructionError":[0,{"Custom":11}]} | state drift (4 accounts differ between the two reads) |
| PumpSwap | 4HdXGLoNeyB4… | needs_requote (ExceededSlippage) | needs_requote (ExceededSlippage) | {"InstructionError":[3,{"Custom":528}]} | {"InstructionError":[3,{"Custom":6004}]} | state drift (9 accounts differ between the two reads) |
| PumpSwap | 2HYSbR1LH1ng… | needs_requote (ExceededSlippage) | needs_requote (ExceededSlippage) | {"InstructionError":[3,{"Custom":1}]} | {"InstructionError":[3,{"Custom":2005}]} | runtime, rent parameters (#870): the surfnet fails a rent check mainnet passes |

Runtime divergences are the ones worth filing: the surfnet held the same bytes in every account the transaction touches and still ran it differently. State divergences are balance or pool drift between the two reads and say nothing about the runtime.

Reproduce any row: `getTransaction(signature, {encoding: "base64", maxSupportedTransactionVersion: 1})` on mainnet, then `simulateTransaction` of those bytes with `sigVerify: false, replaceRecentBlockhash: true` on both RPCs.

Full signatures and verdicts: `2026-10-24.json` beside this file. Known upstream: solana-foundation/surfpool #870 (rent parameters behind SIMD-0437; fix in #873).
