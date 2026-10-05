//! Offline verifier for TxWhy repairs.
//!
//! A repaired Solana transaction is only allowed to differ from the original in these ways:
//!
//! 1. ComputeBudget instructions may be added, removed or changed.
//! 2. One Jupiter v6 swap may be replaced by another Jupiter v6 swap for the same user, the same
//!    source and receiving token accounts, the same output mint, the same amount and the same
//!    slippage tolerance, optionally preceded by idempotent token-account creation.
//! 3. One Pump.fun, PumpSwap or Raydium AMM v4 swap may have only its limit (max cost or min
//!    output) moved, by at most 25% against the user; amount, accounts and flags identical.
//! 4. The recent blockhash (not an instruction, so not checked here).
//!
//! Everything else must be identical and in the same order: same fee payer, same set of signers,
//! every other instruction byte for byte. No network access, no Solana dependencies.
//!
//! This is a port of `src/lib/verify.ts` from TxWhy (<https://txwhy.vercel.app>), and the
//! server runs the same rule on its own output.

use std::collections::BTreeSet;

pub const COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";
pub const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const JUPITER_V6: &str = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
pub const PUMP_FUN: &str = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
pub const PUMP_SWAP: &str = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
pub const RAYDIUM_V4: &str = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
pub const METEORA_DBC: &str = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
pub const METEORA_DAMM_V2: &str = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
pub const RAYDIUM_LAUNCHLAB: &str = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";

/// A repaired limit may never be worse for the user than this many basis points of the original.
pub const DIRECT_LIMIT_CAP_BPS: u128 = 2_500;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountMeta {
    /// Base58 public key.
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction {
    /// Base58 program id.
    pub program_id: String,
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Kept,
    ComputeBudget,
    SwapReplaced,
    TokenAccountSetup,
    SwapLimitMoved,
    WrapRaised,
}

#[derive(Clone, Debug)]
pub struct Change {
    pub kind: ChangeKind,
    pub program: String,
    pub detail: String,
}

#[derive(Clone, Debug)]
pub struct Verification {
    pub ok: bool,
    /// Human-readable reasons the repair is NOT acceptable. Empty when ok.
    pub violations: Vec<String>,
    pub kept: usize,
    pub changes: Vec<Change>,
}

/* ------------------------------------------------------------------------------------------ */
/* Jupiter v6 swap shapes                                                                      */
/* ------------------------------------------------------------------------------------------ */

#[derive(Clone, Copy)]
enum Amounts {
    At(usize),
    Tail,
}

#[derive(Clone, Copy)]
struct Layout {
    name: &'static str,
    mode: &'static str,
    user: usize,
    destination_mint: usize,
    amounts: Amounts,
    source: usize,
    destinations: &'static [usize],
}

/// Verified against Jupiter v6's on-chain IDL (Sep 2026); mirrors `swap-shape.ts`.
fn jupiter_layout(discriminator: &[u8]) -> Option<Layout> {
    let hex = hex(discriminator);
    Some(match hex.as_str() {
        "e517cb977ae3ad2a" => Layout { name: "route", mode: "ExactIn", user: 1, destination_mint: 5, amounts: Amounts::Tail, source: 2, destinations: &[3, 4] },
        "c1209b3341d69c81" => Layout { name: "shared_accounts_route", mode: "ExactIn", user: 2, destination_mint: 8, amounts: Amounts::Tail, source: 3, destinations: &[6] },
        "bb64facc31c4af14" => Layout { name: "route_v2", mode: "ExactIn", user: 0, destination_mint: 4, amounts: Amounts::At(8), source: 1, destinations: &[2, 7] },
        "d19853937cfed8e9" => Layout { name: "shared_accounts_route_v2", mode: "ExactIn", user: 1, destination_mint: 7, amounts: Amounts::At(9), source: 2, destinations: &[5] },
        "d033ef977b2bed5c" => Layout { name: "exact_out_route", mode: "ExactOut", user: 1, destination_mint: 6, amounts: Amounts::Tail, source: 2, destinations: &[3, 4] },
        "b0d169a89a7d453e" => Layout { name: "shared_accounts_exact_out_route", mode: "ExactOut", user: 2, destination_mint: 8, amounts: Amounts::Tail, source: 3, destinations: &[6] },
        "9d8ab85215f4f324" => Layout { name: "exact_out_route_v2", mode: "ExactOut", user: 0, destination_mint: 4, amounts: Amounts::At(8), source: 1, destinations: &[2, 7] },
        "3560e5cad8bbfa18" => Layout { name: "shared_accounts_exact_out_route_v2", mode: "ExactOut", user: 1, destination_mint: 7, amounts: Amounts::At(9), source: 2, destinations: &[5] },
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapShape {
    pub instruction: &'static str,
    pub mode: &'static str,
    pub user: String,
    pub output_mint: String,
    pub amount: u64,
    /// The other side as quoted when the swap was built: output for ExactIn, input for ExactOut.
    pub quoted_other: u64,
    pub slippage_bps: u16,
    pub source: String,
    pub receiver: String,
}

fn u64_le(data: &[u8], at: usize) -> Option<u64> {
    data.get(at..at + 8).map(|b| u64::from_le_bytes(b.try_into().unwrap()))
}

/// What a Jupiter v6 swap instruction asks for, read from the instruction alone.
pub fn read_swap_shape(ix: &Instruction) -> Option<SwapShape> {
    if ix.program_id != JUPITER_V6 || ix.data.len() < 8 {
        return None;
    }
    let layout = jupiter_layout(&ix.data[..8])?;
    let start = match layout.amounts {
        Amounts::Tail => ix.data.len().checked_sub(19)?,
        Amounts::At(n) => n,
    };
    if start < 8 || start + 18 > ix.data.len() {
        return None;
    }
    let amount = u64_le(&ix.data, start)?;
    let quoted_other = u64_le(&ix.data, start + 8)?;
    let slippage_bps = u16::from_le_bytes([ix.data[start + 16], ix.data[start + 17]]);
    let at = |i: usize| ix.accounts.get(i).map(|a| a.pubkey.clone()).unwrap_or_default();
    let user = at(layout.user);
    let output_mint = at(layout.destination_mint);
    if user.is_empty() || output_mint.is_empty() {
        return None;
    }
    // The one account that actually receives the output: the optional override when present
    // (an unused optional slot holds the Jupiter program id as a placeholder), else the user's.
    let receiver = layout
        .destinations
        .iter()
        .map(|&i| at(i))
        .filter(|a| !a.is_empty() && a != JUPITER_V6)
        .last()
        .unwrap_or_default();
    Some(SwapShape {
        instruction: layout.name,
        mode: layout.mode,
        user,
        output_mint,
        amount,
        quoted_other,
        slippage_bps,
        source: at(layout.source),
        receiver,
    })
}

/* ------------------------------------------------------------------------------------------ */
/* Direct DEX swaps: Pump.fun, PumpSwap, Raydium AMM v4                                         */
/* ------------------------------------------------------------------------------------------ */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    MaxIn,
    MinOut,
}

#[derive(Clone, Copy)]
struct DirectLayout {
    program: &'static str,
    name: &'static str,
    limit: Limit,
    tag_length: usize,
    limit_first: bool,
    /// Account index of the user's input token account, where the layout names it.
    user_in: Option<usize>,
}

/// Discriminators from the programs' on-chain IDLs (Sep 2026); mirrors `swap-shape.ts`.
fn direct_layout(program_id: &str, data: &[u8]) -> Option<DirectLayout> {
    let (tag_length, program) = match program_id {
        PUMP_FUN => (8, "Pump.fun"),
        PUMP_SWAP => (8, "PumpSwap"),
        RAYDIUM_V4 => (1, "Raydium AMM v4"),
        METEORA_DBC => (8, "Meteora DBC"),
        METEORA_DAMM_V2 => (8, "Meteora DAMM v2"),
        RAYDIUM_LAUNCHLAB => (8, "Raydium LaunchLab"),
        _ => return None,
    };
    if data.len() < tag_length {
        return None;
    }
    let tag = hex(&data[..tag_length]);
    let (name, limit, limit_first) = match (program_id, tag.as_str()) {
        (PUMP_FUN, "66063d1201daebea") => ("buy", Limit::MaxIn, false),
        (PUMP_FUN, "b817ee6167c5d33d") => ("buy_v2", Limit::MaxIn, false),
        (PUMP_FUN, "38fc74089edfcd5f") => ("buy_exact_sol_in", Limit::MinOut, false),
        (PUMP_FUN, "c2ab1c46684d5b2f") => ("buy_exact_quote_in_v2", Limit::MinOut, false),
        (PUMP_FUN, "33e685a4017f83ad") => ("sell", Limit::MinOut, false),
        (PUMP_FUN, "5df6823ce7e940b2") => ("sell_v2", Limit::MinOut, false),
        (PUMP_SWAP, "66063d1201daebea") => ("buy", Limit::MaxIn, false),
        (PUMP_SWAP, "c62e1552b4d9e870") => ("buy_exact_quote_in", Limit::MinOut, false),
        (PUMP_SWAP, "33e685a4017f83ad") => ("sell", Limit::MinOut, false),
        (RAYDIUM_V4, "09") => ("swap_base_in", Limit::MinOut, false),
        (RAYDIUM_V4, "0b") => ("swap_base_out", Limit::MaxIn, false),
        (RAYDIUM_V4, "10") => ("swap_base_in", Limit::MinOut, false),
        (RAYDIUM_V4, "11") => ("swap_base_out", Limit::MaxIn, true),
        (RAYDIUM_LAUNCHLAB, "faea0d7bd59c13ec") => ("buy_exact_in", Limit::MinOut, false),
        (RAYDIUM_LAUNCHLAB, "9527de9bd37c981a") => ("sell_exact_in", Limit::MinOut, false),
        (RAYDIUM_LAUNCHLAB, "18d3742869039938") => ("buy_exact_out", Limit::MaxIn, false),
        (RAYDIUM_LAUNCHLAB, "5fc8472208090ba6") => ("sell_exact_out", Limit::MaxIn, false),
        (METEORA_DBC | METEORA_DAMM_V2, "f8c69e91e17587c8") => ("swap", Limit::MinOut, false),
        // swap2 carries a mode byte after the two u64 args: 0 exact in, 1 partial fill, 2 exact out.
        (METEORA_DBC | METEORA_DAMM_V2, "414b3f4ceb5b5b88") => match data.get(tag_length + 16) {
            Some(0) | Some(1) => ("swap2", Limit::MinOut, false),
            Some(2) => ("swap2 (exact out)", Limit::MaxIn, false),
            _ => return None,
        },
        _ => return None,
    };
    let user_in = match (program_id, name) {
        (METEORA_DBC, _) => Some(3),
        (METEORA_DAMM_V2, _) => Some(2),
        (RAYDIUM_LAUNCHLAB, "buy_exact_in" | "buy_exact_out") => Some(6),
        (RAYDIUM_LAUNCHLAB, _) => Some(5),
        _ => None,
    };
    Some(DirectLayout { program, name, limit, tag_length, limit_first, user_in })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectSwapShape {
    pub program: &'static str,
    pub name: &'static str,
    pub limit: Limit,
    pub discriminator: String,
    pub amount: u64,
    pub limit_value: u64,
    pub accounts: Vec<String>,
    pub tail: Vec<u8>,
    /// The user's input token account, where the layout names it.
    pub user_in: Option<String>,
}

/// What a direct Pump.fun / PumpSwap / Raydium / Meteora swap asks for, read from the instruction alone.
pub fn read_direct_swap_shape(ix: &Instruction) -> Option<DirectSwapShape> {
    let layout = direct_layout(&ix.program_id, &ix.data)?;
    let t = layout.tag_length;
    if ix.data.len() < t + 16 {
        return None;
    }
    let (amount_at, limit_at) = if layout.limit_first { (t + 8, t) } else { (t, t + 8) };
    Some(DirectSwapShape {
        program: layout.program,
        name: layout.name,
        limit: layout.limit,
        discriminator: hex(&ix.data[..t]),
        amount: u64_le(&ix.data, amount_at)?,
        limit_value: u64_le(&ix.data, limit_at)?,
        accounts: ix
            .accounts
            .iter()
            .map(|a| format!("{}:{}{}", a.pubkey, if a.is_signer { "s" } else { "" }, if a.is_writable { "w" } else { "" }))
            .collect(),
        tail: ix.data[t + 16..].to_vec(),
        user_in: layout.user_in.and_then(|at| ix.accounts.get(at)).map(|a| a.pubkey.clone()),
    })
}

const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";

/// A System Program transfer (tag 2): (from, to, lamports).
pub fn read_system_transfer(ix: &Instruction) -> Option<(String, String, u64)> {
    if ix.program_id != SYSTEM_PROGRAM || ix.accounts.len() < 2 || ix.data.len() != 12 {
        return None;
    }
    if u32::from_le_bytes(ix.data[0..4].try_into().ok()?) != 2 {
        return None;
    }
    Some((ix.accounts[0].pubkey.clone(), ix.accounts[1].pubkey.clone(), u64_le(&ix.data, 4)?))
}

/// An exact-output swap that wraps exactly its maximum cost in SOL cannot pay a higher price unless
/// the wrap rises with the limit. The raise is allowed only when the maximum rose, the transfer grew
/// by no more than the maximum did, and by no more than the cap relative to the original transfer.
pub fn allowed_wrap_raise(wrap_before: u64, wrap_after: u64, limit_before: u64, limit_after: u64) -> bool {
    if wrap_after <= wrap_before || limit_after <= limit_before {
        return false;
    }
    let raise = (wrap_after - wrap_before) as u128;
    raise <= (limit_after - limit_before) as u128 && raise <= wrap_before as u128 * DIRECT_LIMIT_CAP_BPS / 10_000
}

/// A replacement Jupiter quote may move at most the cap against the user: output no more than 25%
/// lower (ExactIn), cost no more than 25% higher (ExactOut). A zero quote in the original constrains nothing.
pub fn allowed_quote_move(mode: &str, before: u64, after: u64) -> bool {
    if before == 0 {
        return true;
    }
    let cap = before as u128 * DIRECT_LIMIT_CAP_BPS / 10_000;
    if mode == "ExactIn" {
        after as u128 >= (before as u128).saturating_sub(cap)
    } else {
        after as u128 <= before as u128 + cap
    }
}

/// True when `after` is the same direct swap as `before` with only the limit moved, and moved no
/// further against the user than the cap allows.
pub fn allowed_direct_limit_change(before: &DirectSwapShape, after: &DirectSwapShape) -> Result<(), String> {
    if before.discriminator != after.discriminator || before.program != after.program {
        return Err("the instruction kind".into());
    }
    if before.amount != after.amount {
        return Err("the amount".into());
    }
    if before.tail != after.tail {
        return Err("the instruction flags".into());
    }
    if before.accounts != after.accounts {
        return Err("the accounts".into());
    }
    let base = before.limit_value as u128;
    let cap = base * DIRECT_LIMIT_CAP_BPS / 10_000;
    match before.limit {
        Limit::MaxIn => {
            if after.limit_value as u128 > base + cap {
                return Err(format!("the maximum cost, by more than {}%", DIRECT_LIMIT_CAP_BPS / 100));
            }
        }
        Limit::MinOut => {
            if (after.limit_value as u128) < base.saturating_sub(cap) {
                return Err(format!("the minimum received, by more than {}%", DIRECT_LIMIT_CAP_BPS / 100));
            }
        }
    }
    Ok(())
}

/* ------------------------------------------------------------------------------------------ */
/* The verifier                                                                                */
/* ------------------------------------------------------------------------------------------ */

fn same_instruction(a: &Instruction, b: &Instruction) -> bool {
    a.program_id == b.program_id
        && a.accounts.len() == b.accounts.len()
        && a.accounts.iter().zip(&b.accounts).all(|(x, y)| x.pubkey == y.pubkey)
        && a.data == b.data
}

fn signer_set(payer: &str, instructions: &[Instruction]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    out.insert(payer.to_string());
    for ix in instructions {
        for a in &ix.accounts {
            if a.is_signer {
                out.insert(a.pubkey.clone());
            }
        }
    }
    out
}

fn is_compute_budget(ix: &Instruction) -> bool {
    ix.program_id == COMPUTE_BUDGET
}

/// Associated Token Account "CreateIdempotent" (tag 1): harmless if the account already exists.
fn is_idempotent_ata_create(ix: &Instruction) -> bool {
    ix.program_id == ATA_PROGRAM && ix.data.first() == Some(&1)
}

fn describe_budget(ix: &Instruction) -> String {
    let d = &ix.data;
    match d.first() {
        Some(2) if d.len() >= 5 => format!("compute unit limit {}", u32::from_le_bytes(d[1..5].try_into().unwrap())),
        Some(3) if d.len() >= 9 => format!("priority fee {} micro-lamports per compute unit", u64::from_le_bytes(d[1..9].try_into().unwrap())),
        Some(4) if d.len() >= 5 => format!("loaded account data limit {} bytes", u32::from_le_bytes(d[1..5].try_into().unwrap())),
        Some(1) if d.len() >= 5 => format!("heap frame {} bytes", u32::from_le_bytes(d[1..5].try_into().unwrap())),
        _ => "compute budget setting".to_string(),
    }
}

/// Verify a repair without trusting the service that made it. Mirrors `verifyInstructions()`.
pub fn verify_instructions(original_payer: &str, original: &[Instruction], repaired_payer: &str, repaired: &[Instruction]) -> Verification {
    let mut violations = Vec::new();
    let mut changes = Vec::new();
    let mut kept = 0usize;

    if original_payer != repaired_payer {
        violations.push(format!("The fee payer changed from {original_payer} to {repaired_payer}."));
    }
    let before = signer_set(original_payer, original);
    let after = signer_set(repaired_payer, repaired);
    for s in after.difference(&before) {
        violations.push(format!("A new required signer was added: {s}."));
    }
    for s in before.difference(&after) {
        violations.push(format!("A required signer was removed: {s}."));
    }
    for ix in repaired.iter().filter(|ix| is_compute_budget(ix)) {
        changes.push(Change { kind: ChangeKind::ComputeBudget, program: "Compute Budget".into(), detail: describe_budget(ix) });
    }

    let a: Vec<&Instruction> = original.iter().filter(|ix| !is_compute_budget(ix)).collect();
    let b: Vec<&Instruction> = repaired.iter().filter(|ix| !is_compute_budget(ix)).collect();
    let (mut i, mut j) = (0usize, 0usize);
    // A SOL transfer that was raised and still has to be justified by the swap it funds: (to, before, after).
    let mut pending_wrap: Option<(String, u64, u64)> = None;
    while i < a.len() && j < b.len() {
        if same_instruction(a[i], b[j]) {
            kept += 1;
            i += 1;
            j += 1;
            continue;
        }
        if pending_wrap.is_none() {
            if let (Some((from_a, to_a, was)), Some((from_b, to_b, now))) = (read_system_transfer(a[i]), read_system_transfer(b[j])) {
                if from_a == from_b && to_a == to_b && now > was {
                    pending_wrap = Some((to_a, was, now));
                    i += 1;
                    j += 1;
                    continue;
                }
            }
        }
        if a[i].program_id == JUPITER_V6 {
            // Allowed: [idempotent token-account creation]* followed by one equivalent Jupiter swap.
            let mut k = j;
            while k < b.len() && is_idempotent_ata_create(b[k]) {
                k += 1;
            }
            let was = read_swap_shape(a[i]);
            let now = b.get(k).filter(|c| c.program_id == JUPITER_V6).and_then(|c| read_swap_shape(c));
            let (was, now) = match (was, now) {
                (Some(w), Some(n)) => (w, n),
                _ => {
                    violations.push(format!("Instruction {} (a Jupiter swap) was changed into something that is not an equivalent swap.", i + 1));
                    break;
                }
            };
            let mut mismatches = Vec::new();
            if was.user != now.user { mismatches.push("the swapping wallet"); }
            if was.output_mint != now.output_mint { mismatches.push("the output token"); }
            if was.mode != now.mode { mismatches.push("the swap mode"); }
            if was.amount != now.amount { mismatches.push("the amount"); }
            if was.slippage_bps != now.slippage_bps { mismatches.push("the slippage tolerance"); }
            if !allowed_quote_move(was.mode, was.quoted_other, now.quoted_other) {
                mismatches.push(if was.mode == "ExactIn" { "the quoted output, by more than 25% against the user" } else { "the quoted cost, by more than 25% against the user" });
            }
            if was.source != now.source { mismatches.push("the token account the input is taken from"); }
            if was.receiver.is_empty() || was.receiver != now.receiver { mismatches.push("the token account that receives the output"); }
            if !mismatches.is_empty() {
                violations.push(format!("The replacement swap changes {}.", mismatches.join(", ")));
                break;
            }
            for _ in j..k {
                changes.push(Change { kind: ChangeKind::TokenAccountSetup, program: "Associated Token Account".into(), detail: "create token account if missing (idempotent)".into() });
            }
            changes.push(Change {
                kind: ChangeKind::SwapReplaced,
                program: "Jupiter Aggregator v6".into(),
                detail: format!("same wallet, output token, amount and {:.2}% tolerance; new route and quote", was.slippage_bps as f64 / 100.0),
            });
            i += 1;
            j = k + 1;
            continue;
        }
        if direct_layout(&a[i].program_id, &a[i].data).is_some() && b[j].program_id == a[i].program_id {
            // Allowed: the same Pump.fun / PumpSwap / Raydium swap with only its limit moved, within the cap.
            let was = read_direct_swap_shape(a[i]);
            let now = read_direct_swap_shape(b[j]);
            let verdict = match (&was, &now) {
                (Some(w), Some(n)) => allowed_direct_limit_change(w, n),
                _ => Err("the swap".to_string()),
            };
            match (verdict, was, now) {
                (Ok(()), Some(w), Some(n)) => {
                    if let Some((to, was, now)) = pending_wrap.take() {
                        let justified = w.limit == Limit::MaxIn && w.user_in.as_deref() == Some(to.as_str()) && allowed_wrap_raise(was, now, w.limit_value, n.limit_value);
                        if !justified {
                            violations.push(format!("A SOL transfer to {to} was raised from {was} to {now} lamports, which the limit move of this swap does not justify."));
                            break;
                        }
                        changes.push(Change {
                            kind: ChangeKind::WrapRaised,
                            program: "System Program".into(),
                            detail: format!("SOL wrapped into the input account of the swap {was} -> {now} lamports, no more than the maximum cost rose"),
                        });
                    }
                    changes.push(Change {
                        kind: ChangeKind::SwapLimitMoved,
                        program: w.program.into(),
                        detail: format!(
                            "same {}, same amount and accounts; {} {} -> {}",
                            w.name,
                            if w.limit == Limit::MaxIn { "maximum cost" } else { "minimum received" },
                            w.limit_value,
                            n.limit_value
                        ),
                    });
                    i += 1;
                    j += 1;
                    continue;
                }
                (Err(reason), was, _) => {
                    violations.push(format!("The replacement {} instruction changes {}.", was.map(|w| w.program).unwrap_or("swap"), reason));
                    break;
                }
                _ => unreachable!(),
            }
        }
        violations.push(format!("Instruction {} (program {}) is not the same in the repaired transaction.", i + 1, a[i].program_id));
        break;
    }
    if violations.is_empty() {
        if let Some((to, was, now)) = &pending_wrap {
            violations.push(format!("A SOL transfer to {to} was raised from {was} to {now} lamports with no swap limit move to justify it."));
        }
    }
    if violations.is_empty() {
        if i < a.len() {
            violations.push(format!("{} original instruction(s) are missing from the repaired transaction.", a.len() - i));
        }
        if j < b.len() {
            violations.push(format!("The repaired transaction contains {} instruction(s) that were not in the original (first: program {}).", b.len() - j, b[j].program_id));
        }
    }
    Verification { ok: violations.is_empty(), violations, kept, changes }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decode a base58 public key to its raw 32 bytes, for callers that hold raw keys.
pub fn decode_pubkey(base58: &str) -> Option<[u8; 32]> {
    let v = bs58::decode(base58).into_vec().ok()?;
    v.try_into().ok()
}

/// Encode raw 32-byte public key as base58, the form the verifier compares.
pub fn encode_pubkey(bytes: &[u8; 32]) -> String {
    bs58::encode(bytes).into_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAYER: &str = "8LnhtUeiP5tYdhuaX2RUXZfVDSyHNmDjNDYFrtoh12V3";
    const OTHER: &str = "GkHrzXWgpKZfGyUaY6xxB7PB7cy6Q3ND4NXMeu4rzSTa";
    const SOURCE: &str = "3nWcZ2Yb8nZ9y7BrMV8m2Fx7Q8Wuzj6C5Bq8Kf3QzZ1A";
    const DEST: &str = "9tE6LtM6KdYZgN6d7pxjdnJq8ZVwCCeVQp3TJzr7nwup";
    const MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const PROG: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    fn acct(k: &str, s: bool, w: bool) -> AccountMeta {
        AccountMeta { pubkey: k.into(), is_signer: s, is_writable: w }
    }
    fn plain(program: &str, data: &[u8]) -> Instruction {
        Instruction { program_id: program.into(), accounts: vec![acct(PAYER, true, true), acct(OTHER, false, true)], data: data.to_vec() }
    }
    fn budget(tag: u8, value: u64) -> Instruction {
        let mut d = vec![tag];
        if tag == 3 { d.extend(value.to_le_bytes()); } else { d.extend((value as u32).to_le_bytes()); }
        Instruction { program_id: COMPUTE_BUDGET.into(), accounts: vec![], data: d }
    }
    /// A `route_v2` Jupiter swap: amounts at byte 8.
    fn jup(amount: u64, slippage: u16, receiver: &str, route: &[u8]) -> Instruction {
        let mut data = hex_to_bytes("bb64facc31c4af14");
        data.extend(amount.to_le_bytes());
        data.extend(0u64.to_le_bytes());
        data.extend(slippage.to_le_bytes());
        data.push(0);
        data.extend(route);
        let mut accounts = vec![acct(PAYER, true, true), acct(SOURCE, false, true), acct(JUPITER_V6, false, false), acct(PROG, false, false), acct(MINT, false, false), acct(PROG, false, false), acct(PROG, false, false), acct(receiver, false, true), acct(OTHER, false, false)];
        accounts.push(acct(OTHER, false, true));
        Instruction { program_id: JUPITER_V6.into(), accounts, data }
    }
    fn jup_quoted(quoted: u64) -> Instruction {
        let mut ix = jup(1_000, 50, DEST, &[1]);
        ix.data[16..24].copy_from_slice(&quoted.to_le_bytes());
        ix
    }
    fn pump_buy(amount: u64, max_cost: u64) -> Instruction {
        let mut data = hex_to_bytes("66063d1201daebea");
        data.extend(amount.to_le_bytes());
        data.extend(max_cost.to_le_bytes());
        data.push(0);
        Instruction { program_id: PUMP_SWAP.into(), accounts: vec![acct(OTHER, false, true), acct(PAYER, true, true), acct(MINT, false, false)], data }
    }
    fn raydium_base_out(amount_out: u64, max_in: u64) -> Instruction {
        let mut data = vec![0x11u8];
        data.extend(max_in.to_le_bytes()); // tag 17 carries the limit first
        data.extend(amount_out.to_le_bytes());
        Instruction { program_id: RAYDIUM_V4.into(), accounts: vec![acct(PROG, false, false), acct(OTHER, false, true), acct(PAYER, true, true)], data }
    }
    fn meteora_swap2(program: &str, amount: u64, limit: u64, mode: u8) -> Instruction {
        let mut data = hex_to_bytes("414b3f4ceb5b5b88");
        data.extend(amount.to_le_bytes());
        data.extend(limit.to_le_bytes());
        data.push(mode);
        Instruction { program_id: program.into(), accounts: vec![acct(PROG, false, false), acct(OTHER, false, true), acct(SOURCE, false, true), acct(DEST, false, true), acct(PAYER, true, true)], data }
    }
    fn wrap(to: &str, lamports: u64) -> Instruction {
        let mut data = 2u32.to_le_bytes().to_vec();
        data.extend(lamports.to_le_bytes());
        Instruction { program_id: "11111111111111111111111111111111".into(), accounts: vec![acct(PAYER, true, true), acct(to, false, true)], data }
    }
    fn hex_to_bytes(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn run(original: &[Instruction], repaired: &[Instruction]) -> Verification {
        verify_instructions(PAYER, original, PAYER, repaired)
    }

    #[test]
    fn identical_is_ok() {
        let v = run(&[plain(PROG, &[1, 2, 3])], &[plain(PROG, &[1, 2, 3])]);
        assert!(v.ok, "{:?}", v.violations);
        assert_eq!(v.kept, 1);
    }

    #[test]
    fn compute_budget_may_be_added_replaced_or_removed() {
        let v = run(&[budget(2, 200_000), plain(PROG, &[1])], &[budget(2, 61_000), budget(3, 5_000), plain(PROG, &[1])]);
        assert!(v.ok);
        assert_eq!(v.changes.len(), 2);
        assert_eq!(v.changes[0].detail, "compute unit limit 61000");
        assert!(v.changes[1].detail.starts_with("priority fee 5000"));
        assert!(run(&[budget(2, 200_000), plain(PROG, &[1])], &[plain(PROG, &[1])]).ok);
    }

    #[test]
    fn changed_data_is_rejected() {
        let v = run(&[plain(PROG, &[1, 2, 3])], &[plain(PROG, &[1, 2, 4])]);
        assert!(!v.ok);
        assert!(v.violations[0].contains("Instruction 1"));
    }

    #[test]
    fn reordering_is_rejected() {
        let a = plain(PROG, &[1]);
        let b = plain(PROG, &[2]);
        assert!(!run(&[a.clone(), b.clone()], &[b, a]).ok);
    }

    #[test]
    fn extra_or_missing_instructions_rejected() {
        let v = run(&[plain(PROG, &[1])], &[plain(PROG, &[1]), plain(PROG, &[9])]);
        assert!(!v.ok);
        assert!(v.violations[0].contains("not in the original"));
        let v = run(&[plain(PROG, &[1]), plain(PROG, &[2])], &[plain(PROG, &[1])]);
        assert!(!v.ok);
        assert!(v.violations[0].contains("missing"));
    }

    #[test]
    fn payer_and_signer_changes_rejected() {
        let v = verify_instructions(PAYER, &[plain(PROG, &[1])], OTHER, &[plain(PROG, &[1])]);
        assert!(v.violations[0].contains("fee payer"));
        let mut extra = plain(PROG, &[1]);
        extra.accounts[1].is_signer = true;
        let v = run(&[plain(PROG, &[1])], &[extra]);
        assert!(v.violations.iter().any(|m| m.contains("new required signer")));
    }

    #[test]
    fn equivalent_jupiter_swap_accepted() {
        let v = run(&[jup(1_000_000, 50, DEST, &[1, 2, 3])], &[jup(1_000_000, 50, DEST, &[7, 8, 9, 10])]);
        assert!(v.ok, "{:?}", v.violations);
        assert_eq!(v.changes[0].kind, ChangeKind::SwapReplaced);
        assert!(v.changes[0].detail.contains("0.50%"));
    }

    #[test]
    fn jupiter_swap_with_ata_setup_accepted() {
        let ata = Instruction { program_id: ATA_PROGRAM.into(), accounts: vec![acct(PAYER, true, true)], data: vec![1] };
        let v = run(&[jup(5, 10, DEST, &[1])], &[ata, jup(5, 10, DEST, &[2])]);
        assert!(v.ok, "{:?}", v.violations);
        assert_eq!(v.changes.iter().filter(|c| c.kind == ChangeKind::TokenAccountSetup).count(), 1);
        let non_idempotent = Instruction { program_id: ATA_PROGRAM.into(), accounts: vec![acct(PAYER, true, true)], data: vec![0] };
        assert!(!run(&[jup(5, 10, DEST, &[1])], &[non_idempotent, jup(5, 10, DEST, &[2])]).ok);
    }

    #[test]
    fn jupiter_swap_changing_terms_rejected() {
        let cases = [
            (jup(1_000_001, 50, DEST, &[1]), "the amount"),
            (jup(1_000_000, 100, DEST, &[1]), "the slippage tolerance"),
            (jup(1_000_000, 50, OTHER, &[1]), "receives the output"),
        ];
        for (after, needle) in cases {
            let v = run(&[jup(1_000_000, 50, DEST, &[1])], &[after]);
            assert!(!v.ok);
            assert!(v.violations[0].contains(needle), "{}", v.violations[0]);
        }
    }

    #[test]
    fn direct_limit_move_within_cap_accepted() {
        let v = run(&[pump_buy(1000, 10_000)], &[pump_buy(1000, 12_500)]);
        assert!(v.ok, "{:?}", v.violations);
        assert_eq!(v.changes[0].kind, ChangeKind::SwapLimitMoved);
        assert!(v.changes[0].detail.contains("10000 -> 12500"));
        // Moving in the user's favour is always fine.
        assert!(run(&[pump_buy(1000, 10_000)], &[pump_buy(1000, 1)]).ok);
    }

    #[test]
    fn direct_limit_move_past_cap_rejected() {
        let v = run(&[pump_buy(1000, 10_000)], &[pump_buy(1000, 12_501)]);
        assert!(!v.ok);
        assert!(v.violations[0].contains("maximum cost, by more than 25%"), "{}", v.violations[0]);
    }

    #[test]
    fn direct_amount_or_accounts_change_rejected() {
        let v = run(&[pump_buy(1000, 10_000)], &[pump_buy(1001, 10_000)]);
        assert!(v.violations[0].contains("the amount"));
        let mut moved = pump_buy(1000, 10_000);
        moved.accounts[0] = acct(DEST, false, true);
        let v = run(&[pump_buy(1000, 10_000)], &[moved]);
        assert!(v.violations[0].contains("the accounts"));
    }

    #[test]
    fn raydium_limit_first_layout_min_out() {
        let v = run(&[raydium_base_out(5_000, 100_000)], &[raydium_base_out(5_000, 125_000)]);
        assert!(v.ok, "{:?}", v.violations);
        assert!(v.changes[0].detail.contains("swap_base_out"));
        assert!(!run(&[raydium_base_out(5_000, 100_000)], &[raydium_base_out(5_000, 125_001)]).ok);
        assert!(!run(&[raydium_base_out(5_000, 100_000)], &[raydium_base_out(5_001, 100_000)]).ok);
    }

    #[test]
    fn meteora_swap2_modes() {
        // Exact in: the limit is a minimum and may drop at most 25%.
        let v = run(&[meteora_swap2(METEORA_DBC, 1_000, 10_000, 0)], &[meteora_swap2(METEORA_DBC, 1_000, 7_500, 0)]);
        assert!(v.ok, "{:?}", v.violations);
        assert_eq!(v.changes[0].kind, ChangeKind::SwapLimitMoved);
        assert!(!run(&[meteora_swap2(METEORA_DBC, 1_000, 10_000, 0)], &[meteora_swap2(METEORA_DBC, 1_000, 7_499, 0)]).ok);
        // Exact out: the limit is a maximum and may rise at most 25%.
        assert!(run(&[meteora_swap2(METEORA_DAMM_V2, 1_000, 10_000, 2)], &[meteora_swap2(METEORA_DAMM_V2, 1_000, 12_500, 2)]).ok);
        assert!(!run(&[meteora_swap2(METEORA_DAMM_V2, 1_000, 10_000, 2)], &[meteora_swap2(METEORA_DAMM_V2, 1_000, 12_501, 2)]).ok);
        // The mode byte may never change, and an unknown mode is not a swap this table knows.
        assert!(!run(&[meteora_swap2(METEORA_DAMM_V2, 1_000, 10_000, 0)], &[meteora_swap2(METEORA_DAMM_V2, 1_000, 10_000, 2)]).ok);
        assert!(read_direct_swap_shape(&meteora_swap2(METEORA_DBC, 1, 1, 3)).is_none());
        assert!(!run(&[meteora_swap2(METEORA_DBC, 1_000, 10_000, 0)], &[meteora_swap2(METEORA_DBC, 1_001, 10_000, 0)]).ok);
    }

    #[test]
    fn jupiter_quote_may_not_move_past_the_cap() {
        assert!(run(&[jup_quoted(10_000)], &[jup_quoted(7_500)]).ok);
        assert!(run(&[jup_quoted(10_000)], &[jup_quoted(12_000)]).ok);
        let v = run(&[jup_quoted(10_000)], &[jup_quoted(7_499)]);
        assert!(!v.ok);
        assert!(v.violations[0].contains("quoted output, by more than 25%"), "{}", v.violations[0]);
        // A zero quote in the original constrains nothing (older fixtures and token-ledger paths).
        assert!(run(&[jup_quoted(0)], &[jup_quoted(1)]).ok);
    }

    #[test]
    fn launchlab_limits() {
        let ix = |tag: &str, amount: u64, limit: u64| {
            let mut data = hex_to_bytes(tag);
            data.extend(amount.to_le_bytes());
            data.extend(limit.to_le_bytes());
            data.extend(0u64.to_le_bytes()); // share_fee_rate
            Instruction { program_id: RAYDIUM_LAUNCHLAB.into(), accounts: vec![acct(PAYER, true, true), acct(OTHER, false, true)], data }
        };
        assert!(run(&[ix("9527de9bd37c981a", 1_000, 10_000)], &[ix("9527de9bd37c981a", 1_000, 7_500)]).ok);
        assert!(!run(&[ix("9527de9bd37c981a", 1_000, 10_000)], &[ix("9527de9bd37c981a", 1_000, 7_499)]).ok);
        assert!(run(&[ix("18d3742869039938", 1_000, 10_000)], &[ix("18d3742869039938", 1_000, 12_500)]).ok);
        assert!(!run(&[ix("18d3742869039938", 1_000, 10_000)], &[ix("18d3742869039938", 1_000, 12_501)]).ok);
        // A sell may not be turned into a buy.
        assert!(!run(&[ix("9527de9bd37c981a", 1_000, 10_000)], &[ix("faea0d7bd59c13ec", 1_000, 10_000)]).ok);
    }

    #[test]
    fn wrap_may_rise_only_with_the_maximum_it_funds() {
        // DAMM v2 lists the input token account at index 2 (SOURCE here).
        let before = [wrap(SOURCE, 10_000), meteora_swap2(METEORA_DAMM_V2, 500, 10_000, 2)];
        let v = run(&before, &[wrap(SOURCE, 11_000), meteora_swap2(METEORA_DAMM_V2, 500, 11_000, 2)]);
        assert!(v.ok, "{:?}", v.violations);
        assert_eq!(v.changes[0].kind, ChangeKind::WrapRaised);
        // Raised more than the maximum rose.
        assert!(!run(&before, &[wrap(SOURCE, 11_001), meteora_swap2(METEORA_DAMM_V2, 500, 11_000, 2)]).ok);
        // Raised with no limit move at all.
        assert!(!run(&before, &[wrap(SOURCE, 11_000), meteora_swap2(METEORA_DAMM_V2, 500, 10_000, 2)]).ok);
        // Raised past the cap of the original transfer, even though the maximum rose as much.
        let small = [wrap(SOURCE, 1_000), meteora_swap2(METEORA_DAMM_V2, 500, 10_000, 2)];
        assert!(!run(&small, &[wrap(SOURCE, 1_251), meteora_swap2(METEORA_DAMM_V2, 500, 12_500, 2)]).ok);
        // A transfer to any other account may never rise.
        let other = [wrap(OTHER, 10_000), meteora_swap2(METEORA_DAMM_V2, 500, 10_000, 2)];
        assert!(!run(&other, &[wrap(OTHER, 11_000), meteora_swap2(METEORA_DAMM_V2, 500, 11_000, 2)]).ok);
        // An exact-in swap has a minimum, not a maximum: nothing justifies sending more SOL.
        let exact_in = [wrap(SOURCE, 10_000), meteora_swap2(METEORA_DAMM_V2, 500, 10_000, 0)];
        assert!(!run(&exact_in, &[wrap(SOURCE, 11_000), meteora_swap2(METEORA_DAMM_V2, 500, 9_000, 0)]).ok);
        // The recipient may not change.
        assert!(!run(&before, &[wrap(OTHER, 11_000), meteora_swap2(METEORA_DAMM_V2, 500, 11_000, 2)]).ok);
    }

    #[test]
    fn shapes_read_correctly() {
        let s = read_swap_shape(&jup(42, 30, DEST, &[1])).unwrap();
        assert_eq!((s.amount, s.slippage_bps, s.receiver.as_str(), s.mode), (42, 30, DEST, "ExactIn"));
        let d = read_direct_swap_shape(&pump_buy(7, 9)).unwrap();
        assert_eq!((d.amount, d.limit_value, d.limit, d.name), (7, 9, Limit::MaxIn, "buy"));
        assert!(read_direct_swap_shape(&plain(PROG, &[1])).is_none());
    }

    #[test]
    fn pubkey_roundtrip() {
        let raw = decode_pubkey(PAYER).unwrap();
        assert_eq!(encode_pubkey(&raw), PAYER);
    }
}
