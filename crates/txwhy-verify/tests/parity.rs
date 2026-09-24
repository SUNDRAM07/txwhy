//! Replays real original/repaired pairs produced by the live TxWhy API (exported with
//! `scripts/export-verify-fixture.mjs`) and checks this crate reaches the same verdict and the
//! same change kinds as the TypeScript verifier that ran on the server.

use serde::Deserialize;
use std::collections::BTreeMap;
use txwhy_verify::{verify_instructions, AccountMeta, ChangeKind, Instruction};

#[derive(Deserialize)]
struct Acct { pubkey: String, is_signer: bool, is_writable: bool }
#[derive(Deserialize)]
struct Ix { program_id: String, accounts: Vec<Acct>, data: String }
#[derive(Deserialize)]
struct Tx { payer: String, instructions: Vec<Ix> }
#[derive(Deserialize)]
struct ExpectedChange { kind: String }
#[derive(Deserialize)]
struct Expected { ok: bool, kept: usize, changes: Vec<ExpectedChange> }
#[derive(Deserialize)]
struct Pair { original: Tx, repaired: Tx, expected: Expected }

fn convert(tx: &Tx) -> Vec<Instruction> {
    tx.instructions
        .iter()
        .map(|ix| Instruction {
            program_id: ix.program_id.clone(),
            accounts: ix.accounts.iter().map(|a| AccountMeta { pubkey: a.pubkey.clone(), is_signer: a.is_signer, is_writable: a.is_writable }).collect(),
            data: (0..ix.data.len()).step_by(2).map(|i| u8::from_str_radix(&ix.data[i..i + 2], 16).unwrap()).collect(),
        })
        .collect()
}

fn kind_name(k: &ChangeKind) -> &'static str {
    match k {
        ChangeKind::Kept => "kept",
        ChangeKind::ComputeBudget => "compute_budget",
        ChangeKind::SwapReplaced => "swap_replaced",
        ChangeKind::TokenAccountSetup => "token_account_setup",
        ChangeKind::SwapLimitMoved => "swap_limit_moved",
    }
}

#[test]
fn matches_the_typescript_verifier_on_real_repairs() {
    let raw = include_str!("fixtures.json");
    let pairs: BTreeMap<String, Pair> = serde_json::from_str(raw).unwrap();
    assert!(pairs.len() >= 4, "fixture should hold compute, slippage, pump and raydium pairs");
    for (name, pair) in &pairs {
        let v = verify_instructions(&pair.original.payer, &convert(&pair.original), &pair.repaired.payer, &convert(&pair.repaired));
        assert_eq!(v.ok, pair.expected.ok, "{name}: {:?}", v.violations);
        assert_eq!(v.kept, pair.expected.kept, "{name}: kept count");
        let got: Vec<&str> = v.changes.iter().map(|c| kind_name(&c.kind)).collect();
        let want: Vec<&str> = pair.expected.changes.iter().map(|c| c.kind.as_str()).collect();
        assert_eq!(got, want, "{name}: change kinds");
    }
}

#[test]
fn a_tampered_real_repair_is_caught() {
    let pairs: BTreeMap<String, Pair> = serde_json::from_str(include_str!("fixtures.json")).unwrap();
    let pair = &pairs["slippage"];
    let mut repaired = convert(&pair.repaired);
    // Flip one byte inside the last instruction that is not a compute-budget one.
    let target = repaired.iter_mut().rev().find(|ix| ix.program_id != txwhy_verify::COMPUTE_BUDGET).unwrap();
    let last = target.data.len() - 1;
    target.data[last] ^= 0x01;
    let v = verify_instructions(&pair.original.payer, &convert(&pair.original), &pair.repaired.payer, &repaired);
    assert!(!v.ok, "a one-byte change must be rejected");
}
