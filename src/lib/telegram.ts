/** Sending to Telegram. The bot token lives only in this deployment's environment; the worker relays alerts through /api/telegram/notify. */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendTelegram(chatId: number, html: string, replyTo?: number): Promise<boolean> {
  if (!TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html.slice(0, 4000),
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    }),
  }).catch(() => null);
  return Boolean(res?.ok);
}
