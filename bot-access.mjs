import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { accessKeys, accessStore } from "./bot-store.mjs";
import { inMarketHours } from "./market-hours.mjs";
import { deliver, requirePrivateChat, telegramRequest, TelegramApiError } from "./telegram.mjs";
import { openUpdate } from "./telegram-bridge.mjs";

const loginHelp = "Для доступа отправьте /login ПАРОЛЬ. Получить пароль можно у владельца портфеля.";
const adminMenu = "🛠 Управление доступом\n/code — показать общий пароль\n/rotate — сменить пароль и отозвать доступ гостей\n/portfolio — открыть отчёт\n/analysis — технический обзор акций";
const reportHelp = "Откройте «Отчёт по портфелю» в меню команд или нажмите /portfolio.";
const guestCommands = [{ command: "portfolio", description: "Отчёт по портфелю" }];

function matchesCode(provided, expected) {
  if (typeof provided !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export function planCommands(updates, state, owner, codeFor, now) {
  const guests = new Set(state.guests);
  const replies = new Map();
  const requests = new Set();
  let analysisRequested = false;
  let deniedReports = 0;
  const deletions = [];
  const refreshMenus = new Set();
  let generation = state.generation;
  let lastMutation = state.lastMutation;
  const replay = lastMutation && now - lastMutation.at < 2 * 86400 ? lastMutation.id : 0;
  let changed = false;

  for (const { update_id: id, message } of updates) {
    const chat = String(message?.chat?.id);
    if (message?.chat?.type !== "private" || message.from?.is_bot !== false
        || !/^[1-9]\d*$/.test(chat) || String(message.from.id) !== chat
        || !(message.date >= state.enabledAt) || typeof message.text !== "string") continue;
    const [commandText, argument, extra] = message.text.trim().split(/\s+/, 3);
    const command = commandText.replace(/@[A-Za-z0-9_]+$/, "").toLowerCase();
    const isOwner = chat === owner;
    const hasAccess = isOwner || guests.has(chat);
    const note = text => replies.set(chat, { chat, text });
    const mutate = () => {
      lastMutation = { id, at: now };
      changed = true;
    };

    switch (command) {
      case "/start":
        if (isOwner) note(adminMenu);
        else {
          if (hasAccess) refreshMenus.add(chat);
          note(hasAccess ? reportHelp : loginHelp);
        }
        break;
      case "/admin":
        if (isOwner) replies.set("admin", { chat, admin: true });
        break;
      case "/code":
        if (isOwner && !replies.has("code")) replies.set("code", { chat, code: true });
        break;
      case "/rotate":
        if (!isOwner || id <= replay) break;
        generation++;
        guests.clear();
        replies.set("code", { chat, code: true, rotated: true });
        mutate();
        break;
      case "/login":
        if (argument) deletions.push({ chat_id: chat, message_id: message.message_id });
        if (isOwner) {
          note("У вас уже есть доступ. Управление — /admin.");
        } else if (!extra && matchesCode(argument, codeFor(generation))) {
          if (!hasAccess && id > replay) {
            guests.add(chat);
            mutate();
          }
          if (guests.has(chat)) {
            refreshMenus.add(chat);
            note(`Доступ открыт. ${reportHelp}`);
          }
        } else {
          note(argument ? "Пароль не принят." : loginHelp);
        }
        break;
      case "/logout":
        if (!isOwner && id > replay && guests.delete(chat)) {
          requests.delete(chat);
          note("Доступ закрыт.");
          mutate();
        }
        break;
      case "/portfolio":
        if (hasAccess) requests.add(chat);
        else {
          deniedReports++;
          note(loginHelp);
        }
        break;
      case "/analysis":
        if (isOwner) analysisRequested = true;
        else if (hasAccess) note(reportHelp);
        break;
    }
  }

  return {
    changed, replies: [...replies.values()], requests: [...requests].filter(chat => chat === owner || guests.has(chat)),
    analysisRequested, deniedReports, deletions, refreshMenus: [...refreshMenus].filter(chat => guests.has(chat)),
    state: { ...state, generation, guests: [...guests], lastMutation },
  };
}

async function ignoreUnavailableChat(action) {
  try {
    await action();
    return true;
  } catch (error) {
    if (!(error instanceof TelegramApiError) || ![400, 403].includes(error.status)) throw error;
    return false;
  }
}

async function updateGuestMenu(token, chat, enabled, verify = false) {
  const scope = { type: "chat", chat_id: chat };
  const chat_id = Number(chat);
  return ignoreUnavailableChat(async () => {
    if (!enabled) {
      await telegramRequest(token, "deleteMyCommands", { scope });
      await telegramRequest(token, "setChatMenuButton", { chat_id, menu_button: { type: "default" } });
      return;
    }
    await telegramRequest(token, "setMyCommands", { scope, commands: guestCommands });
    await telegramRequest(token, "setChatMenuButton", { chat_id, menu_button: { type: "commands" } });
    if (verify) {
      const [commands, button] = await Promise.all([
        telegramRequest(token, "getMyCommands", { scope }),
        telegramRequest(token, "getChatMenuButton", { chat_id }),
      ]);
      if (commands.length !== 1 || commands[0].command !== "portfolio" || button.type !== "commands") {
        throw new Error("Telegram не подтвердил меню гостя.");
      }
    }
  });
}

export async function auditAccess(token, owner) {
  const keys = accessKeys(process.env.TELEGRAM_ACCESS_KEY);
  const store = accessStore(keys.encryption, process.env.GITHUB_REPOSITORY, process.env.BOT_ACCESS_GITHUB_TOKEN);
  const saved = await store.read();
  if (!saved) throw new Error("Список доступа Telegram не инициализирован.");
  const tag = chat => {
    const username = [chat.username, ...(chat.active_usernames ?? [])]
      .find(value => typeof value === "string" && /^[A-Za-z0-9_]{1,32}$/.test(value));
    return username ? "@" + username : null;
  };
  const admin = tag(await requirePrivateChat(token, owner));
  const guests = [];
  for (const id of new Set(saved.state.guests)) {
    if (id === owner) continue;
    let username = null;
    await ignoreUnavailableChat(async () => {
      username = tag(await requirePrivateChat(token, id));
    });
    guests.push(username);
  }
  console.log("Telegram access roles: " + JSON.stringify({ admin, guests }));
}

export async function sendDailyGuestReport(token, owner, html, day, previous) {
  const keys = accessKeys(process.env.TELEGRAM_ACCESS_KEY);
  const store = accessStore(keys.encryption, process.env.GITHUB_REPOSITORY, process.env.BOT_ACCESS_GITHUB_TOKEN);
  const saved = await store.read();
  if (!saved) throw new Error("Список доступа Telegram не инициализирован.");
  const sent = new Set(previous?.day === day ? previous.sent : []);
  const guests = [...new Set(saved.state.guests)].filter(chat => chat !== owner);
  let delivered = 0;
  let failed = 0;
  for (const chat of guests) {
    if (!inMarketHours()) break;
    const marker = createHmac("sha256", keys.encryption).update(`daily-report:${day}:${chat}`).digest("hex");
    if (sent.has(marker)) continue;
    try {
      await deliver(html, token, chat);
      sent.add(marker);
      delivered++;
    } catch {
      failed++;
    }
  }
  console.log(`Дневной отчёт гостям: новых отправок — ${delivered}, ошибок — ${failed}, чатов с доступом — ${guests.length}.`);
  return { state: { day, sent: [...sent] }, failed };
}

export async function configureWebhook(token, url, secret, disable) {
  if (disable) {
    await telegramRequest(token, "deleteWebhook");
    if ((await telegramRequest(token, "getWebhookInfo")).url) throw new Error("Telegram не отключил webhook.");
    console.log("Telegram webhook отключён. Команды снова доступны через опрос.");
    return;
  }
  if (!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\/telegram$/.test(url)
      || !/^[a-f0-9]{64}$/.test(secret ?? "")) throw new Error("Проверьте HTTPS-адрес или секрет Telegram webhook.");
  const probe = {
    update_id: 1,
    // A date before access initialization prevents any reply or access change.
    message: { chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false }, date: 0, message_id: 1, text: "/start" },
  };
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(probe),
  }).catch(() => null);
  if (response?.status !== 204) {
    const diagnostic = response?.headers.get("X-Webhook-Diagnostic");
    const status = diagnostic && /^(GitHub HTTP \d{3}|GitHub token (format|permissions)|GitHub rate limit|GitHub repository|encryption|GitHub network)$/.test(diagnostic)
      ? diagnostic : `Worker HTTP ${response?.status ?? "нет связи"}`;
    throw new Error(`Webhook не запустил проверку (${status}).`);
  }
  console.log("Cloudflare Worker принял проверочную команду и запустил GitHub Actions.");
  await telegramRequest(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message"], max_connections: 1 });
  if ((await telegramRequest(token, "getWebhookInfo")).url !== url) throw new Error("Telegram не подтвердил адрес webhook.");
  console.log("Telegram подтвердил адрес webhook.");
}

export async function runBotAccess({ token, owner, initialize, sendAdmin, envelope, getReport, getAnalysis }) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^[1-9]\d*$/.test(owner)) {
    throw new Error("Проверь токен бота и числовой ID личного чата.");
  }
  const keys = accessKeys(process.env.TELEGRAM_ACCESS_KEY);
  const store = accessStore(keys.encryption, process.env.GITHUB_REPOSITORY, process.env.BOT_ACCESS_GITHUB_TOKEN);
  const saved = await store.read();
  const now = Math.floor(Date.now() / 1000);
  if (initialize) {
    if (!saved) {
      await store.write({ enabledAt: now, instance: randomBytes(16).toString("base64url"), generation: 0, guests: [] });
    }
    await requirePrivateChat(token, owner);
    const scope = { type: "chat", chat_id: owner };
    const commands = [
      { command: "admin", description: "Управление доступом" },
      { command: "code", description: "Посмотреть общий пароль" },
      { command: "rotate", description: "Сменить пароль и закрыть доступ гостям" },
      { command: "portfolio", description: "Открыть отчёт" },
      { command: "analysis", description: "Технический обзор акций" },
    ];
    await telegramRequest(token, "setMyCommands", { scope, commands });
    const configured = await telegramRequest(token, "getMyCommands", { scope });
    if (configured.length !== commands.length || commands.some(({ command }) => !configured.some(item => item.command === command))) {
      throw new Error("Telegram не подтвердил личное меню администратора.");
    }
    const guests = [...new Set(saved?.state.guests ?? [])].filter(chat => chat !== owner);
    let menus = 0;
    for (const guest of guests) {
      if (await updateGuestMenu(token, guest, true, true)) menus++;
    }
    console.log(`Telegram подтвердил гостевые меню: ${menus}/${guests.length}.`);
    console.log("Зашифрованный список гостей и личное меню администратора готовы.");
    return;
  }
  if (!saved) throw new Error("Список доступа Telegram не инициализирован.");
  const codeFor = generation => keys.code(saved.state.instance, generation);
  const sendText = async (chatId, message, shareable = false) => {
    const send = () => telegramRequest(token, "sendMessage", {
      chat_id: chatId, text: message, protect_content: !shareable,
    });
    if (chatId === owner) await send();
    else await ignoreUnavailableChat(send);
  };
  const sendOwnerReply = async (reply, { generation, guests }) => {
    if (reply.admin) {
      await sendText(owner, `${adminMenu}\nГостей с доступом: ${guests.length}`);
      console.log("Telegram подтвердил доставку меню администратора.");
    } else {
      const prefix = reply.rotated ? "Доступ всех гостей отозван. Новый пароль" : "Общий пароль";
      await sendText(owner, `${prefix}:\n${codeFor(generation)}`, true);
      console.log("Telegram подтвердил доставку пароля владельцу.");
    }
  };
  if (sendAdmin) {
    await requirePrivateChat(token, owner);
    await sendOwnerReply({ admin: true }, saved.state);
    await sendOwnerReply({ code: true }, saved.state);
    return;
  }

  const poll = { allowed_updates: ["message"], limit: 50, timeout: 0 };
  if (!envelope && (await telegramRequest(token, "getWebhookInfo")).url) {
    console.log("Команды Telegram поступают через webhook.");
    return;
  }
  const updates = envelope
    ? [await openUpdate(envelope, process.env.TELEGRAM_BRIDGE_KEY)]
    : await telegramRequest(token, "getUpdates", poll);
  if (!updates.length) {
    console.log("Новых команд Telegram нет.");
    return;
  }
  const plan = planCommands(updates, saved.state, owner, codeFor, now);
  if (plan.changed) await store.write(plan.state, saved.sha);
  if (plan.deniedReports) console.log("Запрошен отчёт из чата без доступа.");

  for (const deletion of plan.deletions) {
    await ignoreUnavailableChat(() => telegramRequest(token, "deleteMessage", deletion));
  }

  if (plan.changed) {
    for (const chat of saved.state.guests.filter(chat => chat !== owner && !plan.state.guests.includes(chat))) {
      if (!await updateGuestMenu(token, chat, false).catch(() => false)) {
        console.warn("Не удалось убрать меню гостя после отзыва доступа.");
      }
    }
  }
  for (const chat of plan.refreshMenus) {
    if (!await updateGuestMenu(token, chat, true).catch(() => false)) console.warn("Не удалось обновить меню гостя.");
  }

  for (const reply of plan.replies) {
    if (reply.admin || reply.code) await sendOwnerReply(reply, plan.state);
    else await sendText(reply.chat, reply.text);
  }
  const ownerReports = plan.requests.includes(owner) ? [owner] : [];
  const guestReports = plan.requests.filter(chat => chat !== owner);
  for (const [recipients, ownerQuotes] of [[ownerReports, true], [guestReports, false]]) {
    if (!recipients.length) continue;
    if (!inMarketHours()) {
      for (const chat of recipients) await sendText(chat, "Сейчас Мосбиржа закрыта. Запросите отчёт в часы торгов.");
      continue;
    }
    let report;
    try {
      report = await getReport(ownerQuotes);
    } catch {
      console.warn(ownerQuotes ? "Не удалось собрать отчёт владельца." : "Не удалось собрать гостевой отчёт.");
      for (const chat of recipients) await sendText(chat, "Не удалось собрать отчёт. Попробуйте ещё раз чуть позже.");
      continue;
    }
    for (const chat of recipients) {
      if (!inMarketHours()) {
        await sendText(chat, "Сейчас Мосбиржа закрыта. Запросите отчёт в часы торгов.");
      } else if (report.marketActive || (!ownerQuotes && report.pricedPositions > 0)) {
        const delivered = await ignoreUnavailableChat(() => deliver(report.html, token, chat));
        if (delivered) console.log(ownerQuotes ? "Telegram принял отчёт владельца." : "Telegram принял отчёт гостя.");
        else {
          console.warn(ownerQuotes ? "Telegram отклонил отчёт владельца." : "Telegram отклонил отчёт гостя.");
          await sendText(chat, "Telegram не принял отчёт. Попробуйте ещё раз чуть позже.");
        }
      } else {
        await sendText(chat, "Мосбиржа пока не вернула котировки. Попробуйте ещё раз чуть позже.");
      }
    }
  }
  if (plan.analysisRequested) {
    const analysis = inMarketHours() ? await getAnalysis() : null;
    if (analysis && inMarketHours()) await deliver(analysis.html, token, owner);
    else await sendText(owner, "Технический обзор пока недоступен. Попробуйте в часы торгов.");
  }
  // Confirm processed updates only after any access changes are durable.
  if (!envelope) await telegramRequest(token, "getUpdates", { ...poll, offset: updates.at(-1).update_id + 1, limit: 1 });
  console.log("Очередь команд Telegram обработана.");
}
