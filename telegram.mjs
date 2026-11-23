export class TelegramApiError extends Error {
  constructor(method, status) {
    super(`Telegram не подтвердил запрос ${method} (HTTP ${status}).`);
    this.status = status;
  }
}

export async function telegramRequest(token, method, body = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error(`Не удалось связаться с Telegram (${method}).`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new TelegramApiError(method, response.status);
  }
  return payload.result;
}

export async function requirePrivateChat(token, chatId) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^[1-9]\d*$/.test(chatId)) {
    throw new Error("Проверь токен бота и числовой ID личного чата.");
  }
  const chat = await telegramRequest(token, "getChat", { chat_id: chatId });
  if (chat?.type !== "private" || String(chat.id) !== chatId) {
    throw new Error("Адресат не подтверждён как заданный личный чат.");
  }
  return chat;
}

export async function auditBot(token, chatId) {
  await requirePrivateChat(token, chatId);
  const [bot, webhook, description, about, commands] = await Promise.all([
    telegramRequest(token, "getMe"),
    telegramRequest(token, "getWebhookInfo"),
    telegramRequest(token, "getMyDescription"),
    telegramRequest(token, "getMyShortDescription"),
    telegramRequest(token, "getMyCommands"),
  ]);
  console.log("Telegram security: " + JSON.stringify({
    username: bot.username,
    privateChat: true,
    webhookConfigured: Boolean(webhook.url),
    canJoinGroups: bot.can_join_groups === true,
    groupPrivacyEnabled: bot.can_read_all_group_messages !== true,
    inlineEnabled: bot.supports_inline_queries === true,
    guestQueriesEnabled: bot.supports_guest_queries === true,
    publicDescriptionSet: Boolean(description.description || about.short_description),
    defaultCommandsSet: commands.length > 0,
  }));
}

export async function deliver(html, token, chatId) {
  await requirePrivateChat(token, chatId);
  const message = await telegramRequest(token, "sendRichMessage", {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    protect_content: true,
  });
  const tableCount = message?.rich_message?.blocks?.filter(block => block.type === "table").length ?? 0;
  console.log(`Telegram: таблиц в сообщении — ${tableCount}.`);
  if (message?.rich_message?.blocks?.some(block => block.type === "details" && !block.is_open)) {
    console.log("Telegram подтвердил свёрнутый блок подробностей.");
  }
}
