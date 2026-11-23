import { sealUpdate } from "./telegram-bridge.mjs";

const commandPattern = /^\/(start|admin|code|rotate|login|logout|portfolio|analysis)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i;
const empty = status => new Response(null, { status });
const unavailable = reason => new Response(null, { status: 503, headers: { "X-Webhook-Diagnostic": reason } });

function authorized(request, secret) {
  const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!/^[a-f0-9]{64}$/.test(secret ?? "") || supplied?.length !== secret.length) return false;
  let mismatch = 0;
  for (let i = 0; i < secret.length; i++) mismatch |= supplied.charCodeAt(i) ^ secret.charCodeAt(i);
  return mismatch === 0;
}

function privateCommand(update) {
  const { message, update_id } = update ?? {};
  const { chat, from, date, message_id } = message ?? {};
  if (!Number.isSafeInteger(update_id) || update_id <= 0 || chat?.type !== "private"
      || !Number.isSafeInteger(chat.id) || chat.id <= 0 || from?.id !== chat.id || from.is_bot !== false
      || !Number.isSafeInteger(message_id) || !Number.isSafeInteger(date)
      || typeof message.text !== "string" || !commandPattern.test(message.text.trim())) return;
  const text = message.text.trim();
  if (text.length > 128) return;
  return { update_id, message: { chat: { id: chat.id, type: chat.type }, from: { id: from.id, is_bot: false }, date, message_id, text } };
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/telegram") return empty(404);
    if (request.method !== "POST") return empty(405);
    if (!authorized(request, env.TELEGRAM_WEBHOOK_SECRET)) return empty(403);
    let update;
    try {
      update = privateCommand(await request.json());
    } catch {
      return empty(400);
    }
    if (!update) return empty(204);
    const token = env.GITHUB_DISPATCH_TOKEN?.trim();
    if (!/^github_pat_[A-Za-z0-9_]+$/.test(token ?? "")) return unavailable("GitHub token format");
    const repository = env.GITHUB_REPOSITORY;
    if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) return unavailable("GitHub repository");
    const dispatch = `https://api.github.com/repos/${repository}/actions/workflows/telegram-access.yml/dispatches`;
    let telegram_update;
    try {
      telegram_update = await sealUpdate(update, env.TELEGRAM_BRIDGE_KEY);
    } catch {
      return unavailable("encryption");
    }
    try {
      const response = await fetch(dispatch, {
        method: "POST", redirect: "manual",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "moex-portfolio-telegram",
        },
        body: JSON.stringify({ ref: "main", inputs: { telegram_update } }),
      });
      if (response.ok) return empty(204);
      if (response.status === 403) {
        if (response.headers.get("X-RateLimit-Remaining") === "0") return unavailable("GitHub rate limit");
        const error = await response.json().catch(() => null);
        if (error?.message === "Resource not accessible by personal access token") return unavailable("GitHub token permissions");
      }
      return unavailable(`GitHub HTTP ${response.status}`);
    } catch (error) {
      console.error("GitHub dispatch failed:", String(error?.message ?? "unknown").replaceAll(token, "[redacted]"));
      return unavailable("GitHub network");
    }
  },
};
