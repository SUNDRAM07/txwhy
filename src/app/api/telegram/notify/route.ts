import { sendTelegram } from "@/lib/telegram";

/**
 * Relay for the worker's wallet-watcher alerts. The worker finds the failed transaction and writes the
 * message; this route only forwards it to Telegram, so the bot token never leaves this deployment.
 */
export async function POST(request: Request) {
  const secret = process.env.WORKER_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { chatId?: unknown; html?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body.chatId !== "number" || typeof body.html !== "string" || body.html.length === 0 || body.html.length > 4000) {
    return Response.json({ error: "chatId (number) and html (string ≤ 4000) required" }, { status: 400 });
  }
  const sent = await sendTelegram(body.chatId, body.html);
  return Response.json({ ok: sent });
}
