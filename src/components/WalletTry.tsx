"use client";

import { useEffect, useState } from "react";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { RepairView, useRepair } from "@/components/RepairPanel";
import { verifyInstructions, type Verification } from "@/lib/verify";

/**
 * "Try it with your own wallet": connect a wallet, let the server build a deliberately stale swap for
 * that wallet, watch the repair, verify it in this browser with the open-source rule, then sign one
 * prompt and send. Nothing here touches a key: the wallet signs, the wallet sends.
 *
 * Wallets are found through the Wallet Standard (the window event handshake, no library), with the
 * injected Phantom, Solflare and Backpack providers as a fallback for older builds.
 */

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const DEMO_LAMPORTS = 5_000_000;
const CHAIN = "solana:mainnet";

interface WalletLike {
  name: string;
  icon?: string;
  connect: () => Promise<string>;
  signAndSend: (tx: VersionedTransaction) => Promise<string>;
}

/* ---------------------------------------------------------------- wallet discovery */

type StandardAccount = { address: string; publicKey: Uint8Array; chains: readonly string[] };
type StandardWallet = {
  name: string;
  icon?: string;
  chains: readonly string[];
  accounts: readonly StandardAccount[];
  // The feature objects are untyped on purpose: this page uses three of them and checks each before calling.
  features: Record<string, { connect?: () => Promise<{ accounts: readonly StandardAccount[] }>; signAndSendTransaction?: (input: unknown) => Promise<{ signature: Uint8Array }[]>; signTransaction?: (input: unknown) => Promise<{ signedTransaction: Uint8Array }[]> }>;
};

/** The Wallet Standard handshake: announce the app, collect what registers, give late wallets a moment. */
type RegisterApi = { register: (...wallets: StandardWallet[]) => () => void };

function discoverStandard(): Promise<StandardWallet[]> {
  return new Promise((resolve) => {
    const found: StandardWallet[] = [];
    const api: RegisterApi = {
      register: (...wallets) => {
        for (const w of wallets) if (!found.some((f) => f.name === w.name)) found.push(w);
        return () => {};
      },
    };
    const onRegister = (e: Event) => {
      const cb = (e as CustomEvent<(api: RegisterApi) => void>).detail;
      if (typeof cb === "function") cb(api);
    };
    window.addEventListener("wallet-standard:register-wallet", onRegister);
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    setTimeout(() => {
      window.removeEventListener("wallet-standard:register-wallet", onRegister);
      resolve(found);
    }, 400);
  });
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = n * BigInt(256) + BigInt(b);
  let out = "";
  while (n > BigInt(0)) {
    out = ALPHABET[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function fromBase64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sendRaw(bytes: Uint8Array): Promise<string> {
  return new Connection(PUBLIC_RPC, "confirmed").sendRawTransaction(bytes, { maxRetries: 3 });
}

function fromStandard(w: StandardWallet): WalletLike | null {
  const f = w.features;
  const connect = f["standard:connect"]?.connect;
  const sendFeature = f["solana:signAndSendTransaction"]?.signAndSendTransaction;
  const signFeature = f["solana:signTransaction"]?.signTransaction;
  if (!connect || (!sendFeature && !signFeature)) return null;
  if (!w.chains.includes(CHAIN)) return null;
  let account: StandardAccount | undefined;
  return {
    name: w.name,
    icon: w.icon,
    async connect() {
      const { accounts } = await connect();
      account = accounts[0] ?? w.accounts[0];
      if (!account) throw new Error("The wallet connected but exposed no account.");
      return account.address;
    },
    async signAndSend(tx) {
      const transaction = tx.serialize();
      if (sendFeature) {
        const [out] = await sendFeature({ transaction, account, chain: CHAIN });
        return base58(out.signature);
      }
      const [signed] = await signFeature!({ transaction, account, chain: CHAIN });
      return sendRaw(signed.signedTransaction);
    },
  };
}

/** Older injected providers: window.phantom.solana, window.solflare, window.backpack.solana. */
function fromInjected(skip: Set<string>): WalletLike[] {
  type Provider = {
    connect: () => Promise<{ publicKey?: { toString(): string } } | void>;
    publicKey?: { toString(): string };
    signAndSendTransaction?: (tx: VersionedTransaction) => Promise<{ signature: string } | string>;
    signTransaction?: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
    isPhantom?: boolean;
    isBackpack?: boolean;
  };
  const w = window as unknown as Record<string, { solana?: Provider } & Provider & { isPhantom?: boolean }>;
  const candidates: [string, Provider | undefined][] = [
    ["Phantom", (w.phantom?.solana as Provider | undefined) ?? (w.solana?.isPhantom ? (w.solana as Provider) : undefined)],
    ["Solflare", w.solflare as Provider | undefined],
    ["Backpack", (w.backpack?.solana as Provider | undefined) ?? (w.solana?.isBackpack ? (w.solana as Provider) : undefined)],
  ];
  const out: WalletLike[] = [];
  for (const [name, p] of candidates) {
    if (!p?.connect || skip.has(name)) continue;
    out.push({
      name,
      async connect() {
        const r = await p.connect();
        const key = (r && typeof r === "object" && r.publicKey) || p.publicKey;
        if (!key) throw new Error("The wallet connected but exposed no account.");
        return key.toString();
      },
      async signAndSend(tx) {
        if (p.signAndSendTransaction) {
          const r = await p.signAndSendTransaction(tx);
          return typeof r === "string" ? r : r.signature;
        }
        if (!p.signTransaction) throw new Error("This wallet cannot sign transactions from a page.");
        const signed = await p.signTransaction(tx);
        return sendRaw(signed.serialize());
      },
    });
  }
  return out;
}

/* ---------------------------------------------------------------- verification in the browser */

async function decompile(conn: Connection, base64: string) {
  const tx = VersionedTransaction.deserialize(fromBase64(base64));
  const tables: AddressLookupTableAccount[] = [];
  for (const lookup of tx.message.addressTableLookups ?? []) {
    const r = await conn.getAddressLookupTable(lookup.accountKey);
    if (r.value) tables.push(r.value);
  }
  const message = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
  return { tx, payer: message.payerKey, instructions: message.instructions };
}

async function verifyHere(original: string, repaired: string): Promise<{ verification: Verification; tx: VersionedTransaction }> {
  const conn = new Connection(PUBLIC_RPC, "confirmed");
  const [o, r] = await Promise.all([decompile(conn, original), decompile(conn, repaired)]);
  return { verification: verifyInstructions({ payer: o.payer, instructions: o.instructions }, { payer: r.payer, instructions: r.instructions }), tx: r.tx };
}

/* ---------------------------------------------------------------- the card */

type Step = "idle" | "connecting" | "connected" | "building" | "repairing" | "signing" | "sent";

export function WalletTry() {
  const [wallets, setWallets] = useState<WalletLike[] | null>(null);
  const [wallet, setWallet] = useState<WalletLike | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [local, setLocal] = useState<Verification | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [landed, setLanded] = useState<string | null>(null);
  const repair = useRepair();

  useEffect(() => {
    let alive = true;
    void (async () => {
      const standard = (await discoverStandard()).map(fromStandard).filter((w): w is WalletLike => w != null);
      const injected = fromInjected(new Set(standard.map((w) => w.name)));
      if (alive) setWallets([...standard, ...injected]);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Once a repair comes back, verify it here with the same rule the SDK uses, before the wallet ever sees it.
  useEffect(() => {
    const repaired = repair.result?.repairedTransaction;
    if (!original || !repaired) return;
    let alive = true;
    verifyHere(original, repaired)
      .then(({ verification }) => alive && setLocal(verification))
      .catch((e: unknown) => alive && setMessage(`Could not verify in the browser: ${e instanceof Error ? e.message : String(e)}`));
    return () => {
      alive = false;
    };
  }, [original, repair.result?.repairedTransaction]);

  async function connect(w: WalletLike) {
    setStep("connecting");
    setMessage(null);
    try {
      const addr = await w.connect();
      setWallet(w);
      setAddress(addr);
      setStep("connected");
      const lamports = await new Connection(PUBLIC_RPC, "confirmed").getBalance(new PublicKey(addr)).catch(() => null);
      setBalance(lamports == null ? null : lamports / 1e9);
    } catch (e) {
      setStep("idle");
      setMessage(e instanceof Error ? e.message : "The wallet did not connect.");
    }
  }

  async function build() {
    if (!address) return;
    setStep("building");
    setMessage(null);
    setLocal(null);
    setSignature(null);
    setLanded(null);
    repair.reset();
    try {
      const res = await fetch(`/api/v1/example?kind=slippage&payer=${address}&lamports=${DEMO_LAMPORTS}`);
      const body = await res.json();
      if (!res.ok || !body.transaction) throw new Error(body.error ?? "Could not build the swap.");
      setOriginal(body.transaction);
      setStep("repairing");
      await repair.run({ transaction: body.transaction });
      setStep("connected");
    } catch (e) {
      setStep("connected");
      setMessage(e instanceof Error ? e.message : "Could not build the swap.");
    }
  }

  async function signAndSend() {
    const repaired = repair.result?.repairedTransaction;
    if (!wallet || !repaired || !original || !local?.ok) return;
    setStep("signing");
    setMessage(null);
    try {
      const { verification, tx } = await verifyHere(original, repaired);
      if (!verification.ok) throw new Error(`Refusing to sign: ${verification.violations.join(" ")}`);
      const sig = await wallet.signAndSend(tx);
      setSignature(sig);
      setStep("sent");
      const conn = new Connection(PUBLIC_RPC, "confirmed");
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const { value } = await conn.getSignatureStatuses([sig]);
        const s = value[0];
        if (s?.err) {
          setLanded(`Failed on chain: ${JSON.stringify(s.err)}`);
          return;
        }
        if (s?.confirmationStatus === "confirmed" || s?.confirmationStatus === "finalized") {
          setLanded(`Landed in slot ${s.slot.toLocaleString("en-US")}.`);
          return;
        }
      }
      setLanded("Still pending after a minute; check the explorer link.");
    } catch (e) {
      setStep("connected");
      setMessage(e instanceof Error ? e.message : "The wallet did not sign.");
    }
  }

  const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
  const busy = step === "connecting" || step === "building" || step === "repairing" || step === "signing";
  const canSign = step !== "signing" && step !== "sent" && repair.result?.status === "repaired" && local?.ok === true;

  return (
    <section className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-500/5 p-4">
      <p className="text-sm font-semibold">Try it with your own wallet.</p>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
        Connect a wallet. TxWhy builds a real {DEMO_LAMPORTS / 1e9} SOL to USDC swap for it on a quote that is 5% too optimistic, so it fails the way a stale quote does. Watch the repair, let this
        browser check it with the open-source rule, then sign one prompt and send. Your key stays in your wallet; this page never sees it.
      </p>

      {!address && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {wallets == null && <span className="text-xs text-neutral-500">Looking for wallets…</span>}
          {wallets?.length === 0 && (
            <span className="text-xs text-neutral-500">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack and reload.</span>
          )}
          {wallets?.map((w) => (
            <button
              key={w.name}
              onClick={() => connect(w)}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-3 py-1.5 text-sm font-medium transition hover:border-emerald-500 hover:text-emerald-600 disabled:opacity-50 dark:border-neutral-700 dark:hover:text-emerald-400"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- wallet icons are data URIs handed over by the wallet itself */}
              {w.icon && <img src={w.icon} alt="" className="h-4 w-4 rounded" />}
              {step === "connecting" ? "Connecting…" : `Connect ${w.name}`}
            </button>
          ))}
        </div>
      )}

      {address && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <span className="font-mono text-xs text-neutral-500">
            {wallet?.name} · {short(address)}
            {balance != null && ` · ${balance.toFixed(4)} SOL`}
          </span>
          <button
            onClick={build}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {step === "building" ? "Building on mainnet state…" : step === "repairing" ? "Repairing…" : "Build the broken swap and repair it"}
          </button>
        </div>
      )}

      {message && <p className="mt-3 text-xs text-red-500">{message}</p>}

      {original && (repair.loading || repair.result || repair.error) && (
        <div className="mt-2">
          <RepairView result={repair.result} error={repair.error} loading={repair.loading} />
        </div>
      )}

      {repair.result?.status === "repaired" && (
        <div className="mt-3 rounded-lg border border-neutral-200 p-3 text-xs dark:border-neutral-800">
          <p className="font-semibold uppercase tracking-wide text-neutral-500">Checked in this browser</p>
          {local == null && <p className="mt-1 text-neutral-500">Running the verifier here, with the lookup tables fetched from a public node…</p>}
          {local?.ok && (
            <p className="mt-1 text-emerald-600 dark:text-emerald-400">
              Same fee payer, same signers, {local.kept} instruction{local.kept === 1 ? "" : "s"} kept byte for byte. The only change: {local.changes.map((c) => c.detail).join("; ")}.
            </p>
          )}
          {local && !local.ok && <p className="mt-1 text-red-500">This browser refuses the rebuild: {local.violations.join(" ")}</p>}
          <p className="mt-2 text-neutral-500">
            Signing sends {DEMO_LAMPORTS / 1e9} SOL from your wallet to buy USDC on mainnet, plus the network fee. The rebuilt transaction carries a fresh blockhash, so sign within a minute.
          </p>
          <button
            onClick={signAndSend}
            disabled={!canSign}
            className="mt-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {step === "signing" ? "Waiting for the wallet…" : step === "sent" ? "Sent" : `Sign and send with ${wallet?.name ?? "the wallet"}`}
          </button>
        </div>
      )}

      {signature && (
        <div className="mt-3 text-xs">
          <p>
            Sent:{" "}
            <a href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer" className="font-mono text-emerald-600 hover:underline dark:text-emerald-400">
              {short(signature)}
            </a>
            {" · "}
            <a href={`/tx/${signature}`} className="text-emerald-600 hover:underline dark:text-emerald-400">
              trace it on TxWhy
            </a>
          </p>
          <p className="mt-1 text-neutral-500">{landed ?? "Waiting for confirmation…"}</p>
        </div>
      )}
    </section>
  );
}
