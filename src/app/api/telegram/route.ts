import { RepairInputError, repair, type RepairResult } from "@/lib/repair";
import { track } from "@/lib/stats";
import { extractSignature, getTrace } from "@/lib/trace";

export const maxDuration = 30;

/**
 * Telegram webhook for @txwhy_bot.
 *
 * Private chat: send a signature, an explorer link, or a base64 transaction.
 * Groups: /why <signature or link> (bots in privacy mode only see commands and mentions).
 * Telegram signs every webhook call with the secret we registered, so anything without
 * it is dropped.
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const SITE = "https://txwhy.vercel.app";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function send(chatId: number, html: string, replyTo?: number) {
  if (!TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html.slice(0, 4000),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    }),
  }).catch(() => undefined);
}

const HELP = [
  "<b>TxWhy</b>: failed Solana transaction in, working transaction out.",
  "",
  "Send me any of these:",
  "• a transaction <b>signature</b> or a Solscan / Explorer / SolanaFM link",
  "• a <b>base64 transaction</b> you are about to send, or that just failed simulation",
  "",
  "I reply with the exact step that failed, why, how to fix it, and when it can be fixed by rebuilding, a repaired unsigned transaction that already passed simulation.",
  "",
  "No failed transaction handy? Send /demo and watch me break a real swap and repair it.",
  "In groups use <code>/why &lt;signature or link&gt;</code>.",
  "I never see or ask for keys. You sign the result yourself.",
  "",
  `Web and API: ${SITE}`,
].join("\n");

const STATUS_LINE: Record<RepairResult["status"], string> = {
  repaired: "✅ <b>Repaired</b>",
  valid: "✅ <b>Already valid</b>",
  needs_requote: "🟠 <b>Needs a fresh quote</b>",
  not_repairable: "🔴 <b>Not repairable by rebuilding</b>",
};

function renderRepair(result: RepairResult): string[] {
  const lines = [STATUS_LINE[result.status], esc(result.summary)];
  for (const c of result.changes) {
    lines.push(`• <b>${esc(c.type.replace(/_/g, " "))}</b>: ${esc(c.before.length > 60 ? c.before.slice(0, 57) + "…" : c.before)} → ${esc(c.after.length > 60 ? c.after.slice(0, 57) + "…" : c.after)}`);
  }
  // One note is enough in a chat. For a refusal the last note is the specific reason; for a repair the first is the headline.
  const note = result.repairedTransaction ? result.notes[0] : result.notes[result.notes.length - 1];
  if (note && note !== result.summary) lines.push(`<i>${esc(note)}</i>`);
  return lines;
}

async function answerSignature(signature: string, caller: string): Promise<string> {
  const trace = await getTrace(signature);
  if (!trace) return "I could not find that transaction on mainnet. It may be too old for the RPC, or on another cluster.";
  if (trace.success) return `✅ That transaction <b>succeeded</b>. Nothing to fix.\n${SITE}/tx/${signature}`;

  const path: string[] = [];
  const walk = (nodes: typeof trace.tree) => {
    for (const n of nodes) {
      if (n.failed) {
        path.push(`#${n.index} ${n.programName}`);
        walk(n.children);
      }
    }
  };
  walk(trace.tree);

  const out = [`❌ <b>${esc(trace.error?.title ?? "Transaction failed")}</b>`];
  if (path.length) out.push(`Failed at: <code>${esc(path.join(" → "))}</code>`);
  let result: RepairResult | null = null;
  try {
    result = await repair({ signature });
  } catch {
    result = null;
  }
  await track({ kind: "repair", channel: "telegram", status: result?.status, errorTitle: trace.error?.title, caller });
  const cause = result?.cause ?? trace.error;
  if (cause?.cause) out.push("", `<b>Why:</b> ${esc(cause.cause)}`);
  if (cause?.fix && result?.status !== "not_repairable") out.push(`<b>Fix:</b> ${esc(cause.fix)}`);

  try {
    if (!result) throw new Error("no repair");
    out.push("", ...renderRepair(result));
    if (result.repairedTransaction) out.push(`Get the rebuilt transaction here: ${SITE}/tx/${signature}`);
    else out.push(`Full trace: ${SITE}/tx/${signature}`);
  } catch {
    out.push("", `Full trace: ${SITE}/tx/${signature}`);
  }
  return out.join("\n");
}

async function answerTransaction(transaction: string, caller: string): Promise<string> {
  try {
    const result = await repair({ transaction });
    await track({ kind: "repair", channel: "telegram", status: result.status, errorTitle: result.cause?.title, caller });
    const out: string[] = [];
    if (result.cause) out.push(`❌ <b>${esc(result.cause.title)}</b>`, esc(result.cause.cause), "");
    out.push(...renderRepair(result));
    if (result.repairedTransaction) {
      out.push(
        "",
        result.repairedTransaction.length < 2600
          ? `<b>Rebuilt transaction (unsigned, base64):</b>\n<code>${result.repairedTransaction}</code>`
          : `The rebuilt transaction is too long for a message. Paste yours at ${SITE}/repair to copy it.`,
      );
    }
    return out.join("\n");
  } catch (e) {
    if (e instanceof RepairInputError) return esc(e.message);
    return "Something went wrong talking to the network. Try again in a moment.";
  }
}

/** Build a deliberately broken swap on live mainnet state, then repair it, so anyone can watch it work. */
async function answerDemo(): Promise<string> {
  try {
    const example = await (await fetch(`${SITE}/api/v1/example?kind=slippage`, { cache: "no-store" })).json();
    if (!example.transaction) throw new Error("no example");
    const result = await repair({ transaction: example.transaction });
    return [
      "<b>Live demo.</b> I just built a real 0.05 SOL → USDC swap on a quote that is 5% too optimistic, so it fails the way a stale quote does. Then I repaired it:",
      "",
      result.cause ? `❌ <b>${esc(result.cause.title)}</b>` : "",
      ...renderRepair(result),
      "",
      `Simulation of the rebuilt swap: <b>${result.simulation.passed ? "passed" : "failed"}</b>${result.simulation.unitsConsumed ? ` (${result.simulation.unitsConsumed.toLocaleString("en-US")} compute units)` : ""}.`,
      `Try the other demos: ${SITE}/repair`,
    ]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n");
  } catch {
    return `The demo could not reach the quote service just now. Try again, or run it at ${SITE}/repair`;
  }
}

/** Looks like a serialized transaction: long, base64 alphabet only. */
const looksLikeTransaction = (s: string) => s.length > 180 && /^[A-Za-z0-9+/=\s]+$/.test(s);

// Per-instance flood guard: 10 requests a minute per chat.
const recent = new Map<number, number[]>();
function flooded(chatId: number): boolean {
  const now = Date.now();
  const times = (recent.get(chatId) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= 10) return true;
  times.push(now);
  recent.set(chatId, times);
  return false;
}

interface Update {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
    reply_to_message?: { text?: string };
  };
}

export async function POST(request: Request) {
  if (!TOKEN || !SECRET) return new Response("not configured", { status: 503 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  let update: Update;
  try {
    update = await request.json();
  } catch {
    return new Response("ok");
  }
  const message = update.message;
  const text = message?.text?.trim();
  if (!message || !text) return new Response("ok");

  const chatId = message.chat.id;
  const isPrivate = message.chat.type === "private";
  const command = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const name = command?.[1]?.toLowerCase();
  let body = command ? command[2].trim() : text;

  if (name === "start" || name === "help") {
    await send(chatId, HELP);
    return new Response("ok");
  }
  if (name === "demo") {
    if (flooded(chatId)) return new Response("ok");
    await send(chatId, await answerDemo(), message.message_id);
    return new Response("ok");
  }
  // In groups, only act on /why (or /repair). "/why" as a reply to a message uses that message's text.
  if (!isPrivate && name !== "why" && name !== "repair") return new Response("ok");
  if (!body && message.reply_to_message?.text) body = message.reply_to_message.text.trim();
  if (!body) {
    await send(chatId, "Send a signature, an explorer link, or a base64 transaction after the command.", message.message_id);
    return new Response("ok");
  }
  if (flooded(chatId)) {
    await send(chatId, "Easy there. Give me a minute and try again.", message.message_id);
    return new Response("ok");
  }

  const signature = extractSignature(body);
  let reply: string;
  if (signature) reply = await answerSignature(signature, `tg:${chatId}`).catch(() => "The network did not answer. Try again in a moment.");
  else if (looksLikeTransaction(body)) reply = await answerTransaction(body.replace(/\s+/g, ""), `tg:${chatId}`);
  else if (isPrivate) reply = "That doesn't look like a signature, an explorer link or a base64 transaction. Send /help to see what I can read.";
  else return new Response("ok");

  await send(chatId, reply, message.message_id);
  return new Response("ok");
}
