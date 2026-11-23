import { createHash } from "node:crypto";
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createAnalysisRequests, createRequests } from "./requests.mjs";
import { buildStockAnalysis } from "./stock-analysis.mjs";
import { buildReport, stockName } from "./report.mjs";
import { inMarketHours, isDailyGuestWindow } from "./market-hours.mjs";
import { auditBot, deliver } from "./telegram.mjs";
import { auditAccess, configureWebhook, runBotAccess, sendDailyGuestReport } from "./bot-access.mjs";
import { fetchBrokerDividends, fetchBrokerMarket, fetchBrokerPortfolio } from "./broker-quotes.mjs";

const { values: args } = parseArgs({
  options: {
    config: { type: "string" },
    send: { type: "boolean", default: false },
    "audit-bot": { type: "boolean", default: false },
    "audit-access": { type: "boolean", default: false },
    "configure-webhook": { type: "boolean", default: false },
    "poll-bot": { type: "boolean", default: false },
    "initialize-access": { type: "boolean", default: false },
    "send-admin": { type: "boolean", default: false },
    "send-analysis": { type: "boolean", default: false },
  },
});
const stateFile = ".portfolio-state.json";
const tradeSymbol = /^[A-Z0-9]{1,16}$/;
const isin = /^[A-Z]{2}[A-Z0-9]{10}$/;
const positive = value => Number.isFinite(value) && value > 0;
const quantity = value => Number.isSafeInteger(value) && value > 0;

function validate(config) {
  if (!Array.isArray(config.stocks) || !Array.isArray(config.bonds)
      || config.stocks.length > 40 || config.bonds.length > 40
      || config.stocks.some(s => typeof s.ticker !== "string" || !tradeSymbol.test(s.ticker)
        || !quantity(s.quantity) || (s.cost !== undefined && !positive(s.cost)))
      || config.bonds.some(b => typeof b.isin !== "string" || !isin.test(b.isin)
        || typeof b.name !== "string" || b.name.length > 100 || /[\r\n]/.test(b.name) || !quantity(b.quantity)
        || (b.cost !== undefined && !positive(b.cost))
        || (b.board !== undefined && !["TQCB", "TQOB"].includes(b.board)))
      || new Set(config.stocks.map(s => s.ticker)).size !== config.stocks.length
      || new Set(config.bonds.map(b => b.isin)).size !== config.bonds.length) {
    throw new Error("Проверь состав портфеля: нужны уникальные тикеры и ISIN, положительное количество и себестоимость акций.");
  }
}

async function loadPortfolio() {
  if (args.config) return { data: JSON.parse(await readFile(args.config, "utf8")), sample: false };
  if (process.env.PORTFOLIO_JSON) return { data: JSON.parse(process.env.PORTFOLIO_JSON), sample: false };
  const sample = JSON.parse(await readFile(new URL("portfolio.example.json", import.meta.url), "utf8"));
  return { data: sample, sample: true };
}

function withPurchaseCosts(data) {
  function applyCosts(positions, json, field) {
    if (!json) return positions;
    const verified = new Map(JSON.parse(json).map(row => [row[field], row]));
    return positions.map(position => {
      if (field === "isin" && position.cost !== undefined) return position;
      const purchase = verified.get(position[field]);
      if (purchase?.quantity !== position.quantity || !positive(purchase?.cost)) return position;
      return { ...position, cost: purchase.cost };
    });
  }
  return { ...data,
    stocks: applyCosts(data.stocks, process.env.STOCK_COSTS_JSON, "ticker"),
    bonds: applyCosts(data.bonds, process.env.BOND_COSTS_JSON, "isin"),
  };
}

function cashSnapshot() {
  return process.env.RUB_CASH_JSON ? JSON.parse(process.env.RUB_CASH_JSON) : undefined;
}

async function loadState(fingerprint) {
  try {
    const stored = JSON.parse(await readFile(stateFile, "utf8"));
    return stored.fingerprint === fingerprint ? stored.reportState : {};
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw new Error("Не удалось прочитать состояние предыдущего запуска.");
  }
}

let reportContext;
function loadReportContext() {
  reportContext ??= (async () => {
    const { data: fallback, sample } = await loadPortfolio();
    validate(fallback);
    const fingerprint = createHash("sha256").update(JSON.stringify(fallback)).digest("hex");
    const previous = await loadState(fingerprint);
    const manualData = { data: withPurchaseCosts(fallback), cash: sample ? undefined : cashSnapshot() };
    const account = process.env.TBANK_PORTFOLIO_ACCOUNT;
    if (!account || sample || args.config) return { ...manualData, fingerprint, previous, sample };
    const source = createHash("sha256").update(account).digest("hex");
    let snapshot;
    let snapshotNotice;
    try {
      const live = await fetchBrokerPortfolio(account, fallback, process.env.TBANK_MARKET_TOKEN, process.env.TBANK_MARKET_CA);
      validate(live.data);
      snapshot = { ...live, source };
      console.log(`Т-Инвестиции · Акции: ${live.data.stocks.map(stock => stock.ticker).join(", ")}. Выпусков облигаций: ${live.data.bonds.length}.`);
    } catch {
      snapshot = previous.brokerSnapshot?.source === source ? previous.brokerSnapshot : undefined;
      snapshotNotice = snapshot ? "Т-Инвестиции недоступны. Показан последний сохранённый состав." : "Т-Инвестиции недоступны. Показан исходный список.";
    }
    if (snapshot?.unsupported) {
      snapshotNotice = [snapshotNotice, `Позиций вне поддерживаемых режимов Мосбиржи: ${snapshot.unsupported}.`].filter(Boolean).join(" ");
    }
    return { ...(snapshot ?? manualData), fingerprint, previous, sample, snapshot, snapshotNotice };
  })();
  return reportContext;
}

async function requestMoex(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
      if (response.ok) return await response.json();
      if (response.status < 500 && response.status !== 429) return null;
      await response.body?.cancel();
    } catch {
      // A transient failure in one ISS endpoint should not suppress other data.
    }
  }
  return null;
}

async function fetchMarket(requests, previous) {
  const result = new Map();
  const coupons = {};
  let fetched = 0;
  const now = Date.now();
  const pending = requests.values();
  async function collectQuotes() {
    for (const request of pending) {
      if (!request.url) continue;
      const key = request.id ? `${request.kind}:${request.id}` : request.kind;
      const cached = request.kind === "coupons" ? previous[request.id] : undefined;
      if (cached && now - cached.checkedAt < 6 * 3600000) {
        coupons[request.id] = cached;
        result.set(key, cached.payload);
        continue;
      }
      fetched++;
      const payload = await requestMoex(request.url);
      if (payload) result.set(key, payload);
      if (request.kind === "coupons" && Array.isArray(payload?.coupons?.data)) {
        coupons[request.id] = { checkedAt: now, payload: { coupons: payload.coupons } };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, requests.length) }, () => collectQuotes()));
  return { result, coupons, fetched };
}

async function showReport(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown + "\n", "utf8");
  } else {
    console.log(markdown);
  }
}

async function marketReport(requests, previous, manual, { cash, ownerQuotes = false, snapshot, snapshotNotice, withDailyGuests = false } = {}) {
  const { TBANK_MARKET_TOKEN: token, TBANK_MARKET_CA: ca } = process.env;
  const [{ result: responses, coupons, fetched }, broker, dividends] = await Promise.all([
    fetchMarket(requests, previous.couponCache ?? {}),
    ownerQuotes ? fetchBrokerMarket(requests, token, ca) : undefined,
    ownerQuotes ? fetchBrokerDividends(requests[0], previous.dividendCache ?? {}, token, ca) : undefined,
  ]);
  const cashOnly = !requests[0].positions.length && !requests[1].positions.length;
  if (responses.size === 0 && !cashOnly) throw new Error("Мосбиржа не ответила ни на один запрос.");
  const report = buildReport({ requests, responses, previous, manual, cash, broker, dividends, trackHistory: ownerQuotes, snapshotNotice });
  if (withDailyGuests) {
    report.guestReport = buildReport({ requests, responses, previous, manual: true, cash, snapshotNotice });
  }
  if (cashOnly) report.marketActive = true;
  if (snapshot) report.state.brokerSnapshot = snapshot;
  report.state.couponCache = coupons;
  if (dividends) report.state.dividendCache = dividends;
  console.log(`Мосбиржа: ${fetched} сетевых запросов, ${requests.filter(request => request.url).length - fetched} из кеша. Свежих котировок акций: ${report.availableStocks}.`);
  if (ownerQuotes) {
    console.log(`Т-Инвестиции: использовано котировок — ${report.brokerQuotesUsed}. Дивидендные календари — ${Object.keys(dividends ?? {}).length}. Точек графика — ${report.state.valuationHistory.length}.`);
  }
  return report;
}

async function stockAnalysis() {
  const { data, sample, previous, snapshotNotice } = await loadReportContext();
  if (sample) throw new Error("Не задан действующий портфель.");
  const request = createRequests(data)[0];
  const marketRequests = createAnalysisRequests(data.stocks, request.today);
  if (data.stocks.some(({ ticker }) => stockName(ticker) === ticker)) marketRequests.push(request);
  const [history, dividends] = await Promise.all([
    fetchMarket(marketRequests, {}),
    fetchBrokerDividends(request, previous.dividendCache ?? {}, process.env.TBANK_MARKET_TOKEN, process.env.TBANK_MARKET_CA),
  ]);
  const candleCount = data.stocks.filter(({ ticker }) => history.result.has(`candles:${ticker}`)).length;
  console.log(`Технический обзор: получено ${candleCount}/${data.stocks.length} рядов свечей, дивидендных календарей ${Object.keys(dividends).length}.`);
  return buildStockAnalysis(data.stocks, request.today, history.result, dividends, snapshotNotice);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
  if (args["configure-webhook"]) {
    await configureWebhook(token, process.env.TELEGRAM_WEBHOOK_URL, process.env.TELEGRAM_WEBHOOK_SECRET, process.env.DISABLE_WEBHOOK === "true");
    return;
  }
  if (args["audit-bot"]) {
    await auditBot(token, chatId);
    return;
  }
  if (args["audit-access"]) {
    await auditAccess(token, chatId);
    return;
  }
  if (args["send-analysis"]) {
    if (!inMarketHours()) throw new Error("Вне часов торгов.");
    const analysis = await stockAnalysis();
    if (!analysis) throw new Error("Не хватило свежих дневных свечей.");
    await deliver(analysis.html, token, chatId);
    console.log("Telegram подтвердил отправку технического обзора.");
    return;
  }
  if (args["poll-bot"] || args["initialize-access"] || args["send-admin"]) {
    const initialize = args["initialize-access"];
    const envelope = process.env.TELEGRAM_WEBHOOK_UPDATE;
    if (!initialize && !envelope && !inMarketHours()) {
      console.log("Вне часов торгов. Очередь Telegram будет проверена в следующую сессию.");
      return;
    }
    await runBotAccess({
      token, owner: chatId, initialize, sendAdmin: args["send-admin"], envelope, getAnalysis: stockAnalysis,
      getReport: async ownerQuotes => {
        const { data, sample, previous, cash, snapshotNotice } = await loadReportContext();
        if (sample) throw new Error("Не задан действующий портфель.");
        return marketReport(createRequests(data), previous, true, { cash, ownerQuotes, snapshotNotice });
      },
    });
    return;
  }
  if (args.send && token && chatId && !inMarketHours()) {
    console.log("Вне часов торгов. Отчёт не отправлен.");
    return;
  }
  const { data, sample, cash, fingerprint, previous, snapshot, snapshotNotice } = await loadReportContext();
  const canSend = args.send && !sample && Boolean(token && chatId);
  const manual = !canSend || process.env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const withDailyGuests = canSend && process.env.GITHUB_EVENT_NAME === "schedule"
    && process.env.SEND_DAILY_GUESTS === "true" && isDailyGuestWindow();
  const requests = createRequests(data);
  const report = await marketReport(requests, previous, manual, { cash, ownerQuotes: canSend, snapshot, snapshotNotice, withDailyGuests });
  if (!canSend) {
    if (sample) console.log("Используется пример портфеля.");
    if (manual) await showReport(report.preview);
    console.log("Режим просмотра. Сообщения в Telegram не отправлены.");
    return;
  }
  if (!inMarketHours()) {
    console.log("Торговое окно завершилось. Отчёт не отправлен.");
    return;
  }
  let ownerError;
  const ownerSending = report.marketActive && (manual || report.shouldNotify);
  if (ownerSending) {
    try {
      await deliver(report.html, token, chatId);
      console.log("Telegram подтвердил отправку отчёта.");
    } catch (error) {
      ownerError = error;
    }
  } else {
    console.log("Нет подтверждённой торговой сессии для отчёта владельца.");
  }
  if (previous.guestDaily) report.state.guestDaily = previous.guestDaily;
  let guestFailure = false;
  const guestReport = report.guestReport;
  if (guestReport && (guestReport.marketActive || guestReport.pricedPositions > 0 || !data.stocks.length && !data.bonds.length)) {
    try {
      const result = await sendDailyGuestReport(token, chatId, guestReport.html, requests[0].today, previous.guestDaily);
      report.state.guestDaily = result.state;
      guestFailure = result.failed > 0;
    } catch (error) {
      console.error(error.message);
      guestFailure = true;
    }
  } else if (guestReport) {
    console.warn("Дневной отчёт гостям пропущен: котировки Мосбиржи недоступны.");
  }
  if (ownerError || !report.marketActive) {
    for (const key of ["coupons", "bondMoves", "issues"]) report.state[key] = previous[key];
  }
  await writeFile(stateFile + ".tmp", JSON.stringify({ fingerprint, reportState: report.state }), { mode: 0o600 });
  await rename(stateFile + ".tmp", stateFile);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, "state_written=true\n", "utf8");
  if (ownerError) throw ownerError;
  if (guestFailure) throw new Error("Дневной отчёт доставлен не всем гостям с доступом.");
}

main().catch(error => {
  console.error(error instanceof SyntaxError ? "Неверный формат JSON состава портфеля." : error.message);
  process.exitCode = 1;
});
