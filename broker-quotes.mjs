import { X509Certificate } from "node:crypto";
import { request } from "node:https";

const statusOpen = new Set(["SECURITY_TRADING_STATUS_NORMAL_TRADING", "SECURITY_TRADING_STATUS_DISCRETE_AUCTION"]);
const instrumentKey = (ticker, board) => `${ticker}_${board}`;
const quotation = value => value ? Number(value.units ?? 0) + Number(value.nano ?? 0) / 1e9 : NaN;

export function parseBrokerPortfolio(payload, fallback) {
  if (!Array.isArray(payload.positions)) throw new Error("Брокер не вернул список позиций.");
  const names = new Map(fallback.bonds.map(row => [row.isin, row.name]));
  const stocks = [];
  const bonds = [];
  let unsupported = 0;
  let rubles = 0;
  for (const position of payload.positions) {
    const { instrumentType, ticker, figi, classCode, averagePositionPrice } = position;
    const quantity = quotation(position.quantity);
    if (instrumentType === "currency" && [ticker, figi].some(value => value === "RUB" || value === "RUB000UTSTOM")) {
      if (!Number.isFinite(quantity)) throw new Error("Брокер вернул некорректный рублёвый остаток.");
      rubles += quantity;
      continue;
    }
    if (!(instrumentType === "share" || instrumentType === "bond") || quantity === 0) continue;
    const average = quotation(averagePositionPrice);
    const cost = averagePositionPrice?.currency?.toLowerCase() === "rub" && average > 0 && Number.isFinite(average)
      ? Math.round(average * quantity * 100) / 100 : undefined;
    if (Number.isSafeInteger(quantity) && quantity > 0) {
      if (instrumentType === "share" && classCode === "TQBR" && /^[A-Z0-9]{1,16}$/.test(ticker)) {
        stocks.push({ ticker, quantity, cost });
        continue;
      }
      if (instrumentType === "bond" && ["TQCB", "TQOB"].includes(classCode) && /^[A-Z]{2}[A-Z0-9]{10}$/.test(ticker)) {
        bonds.push({ isin: ticker, name: names.get(ticker) ?? ticker, board: classCode, quantity, cost });
        continue;
      }
    }
    unsupported++;
  }
  return { data: { stocks, bonds }, cash: { amount: rubles, asOf: new Date().toISOString() }, unsupported };
}

function marketData(method, body, token, ca) {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "invest-public-api.tbank.ru",
      path: "/rest/tinkoff.public.invest.api.contract.v1." + method,
      method: "POST", ca, signal: AbortSignal.timeout(6500),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Брокер не подтвердил запрос рыночных данных."));
        return;
      }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks)));
        } catch {
          reject(new Error("Некорректный ответ с рыночными данными."));
        }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

export function parseBrokerMarket(instruments, quotes = [], statuses = []) {
  const keys = new Set(instruments);
  const prices = new Map();
  for (const { ticker, classCode, price, time, lastPriceType } of quotes) {
    const key = instrumentKey(ticker, classCode);
    const amount = price ? Number(price.units ?? 0) + Number(price.nano ?? 0) / 1e9 : NaN;
    const snapshot = Date.parse(time);
    if (keys.has(key) && lastPriceType === "LAST_PRICE_EXCHANGE" && Number.isFinite(amount)
        && amount > 0 && Number.isFinite(snapshot) && snapshot > (prices.get(key)?.snapshot ?? -Infinity)) {
      prices.set(key, { amount, snapshot });
    }
  }
  const activity = new Map(statuses.filter(row => typeof row.tradingStatus === "string")
    .map(row => [instrumentKey(row.ticker, row.classCode), statusOpen.has(row.tradingStatus)]));
  const boardActive = (...boards) => {
    const relevant = instruments.filter(key => boards.some(board => key.endsWith(`_${board}`)));
    if (relevant.some(key => activity.get(key) === true)) return true;
    if (relevant.length && relevant.every(key => activity.has(key))) return false;
    return undefined;
  };
  return { prices, stocksActive: boardActive("TQBR"), bondsActive: boardActive("TQCB", "TQOB") };
}

function brokerCertificate(token, certificate) {
  if (!token || !certificate) return undefined;
  let ca;
  try {
    const root = new X509Certificate(Buffer.from(certificate, "base64"));
    if (!root.ca || !/Russian Trusted Root CA/i.test(root.subject)) return undefined;
    ca = root.toString();
  } catch {
    return undefined;
  }
  return ca;
}

export async function fetchBrokerMarket(requests, token, certificate) {
  const ca = brokerCertificate(token, certificate);
  if (!ca) return undefined;
  const instruments = [
    ...requests[0].positions.map(row => instrumentKey(row.ticker, "TQBR")),
    ...requests[1].positions.map(row => instrumentKey(row.isin, row.board ?? "TQCB")),
  ];
  if (!instruments.length) return undefined;
  const [quotes, statuses] = await Promise.allSettled([
    marketData("MarketDataService/GetLastPrices", { instrumentId: instruments, lastPriceType: "LAST_PRICE_EXCHANGE" }, token, ca),
    marketData("MarketDataService/GetTradingStatuses", { instrumentId: instruments }, token, ca),
  ]);
  return parseBrokerMarket(instruments,
    quotes.status === "fulfilled" && Array.isArray(quotes.value.lastPrices) ? quotes.value.lastPrices : [],
    statuses.status === "fulfilled" && Array.isArray(statuses.value.tradingStatuses) ? statuses.value.tradingStatuses : []);
}

export async function fetchBrokerPortfolio(accountId, fallback, token, certificate) {
  const ca = brokerCertificate(token, certificate);
  if (!accountId || !ca) throw new Error("Не настроен доступ к брокерскому счёту.");
  const payload = await marketData("OperationsService/GetPortfolio", { accountId, currency: "RUB" }, token, ca);
  if (payload.accountId && payload.accountId !== accountId) throw new Error("Брокер вернул другой счёт.");
  return parseBrokerPortfolio(payload, fallback);
}

export async function fetchBrokerDividends({ positions, today }, previous, token, certificate) {
  const ca = brokerCertificate(token, certificate);
  if (!ca) return previous;
  const now = Date.now();
  const from = new Date(today + "T00:00:00Z");
  const to = new Date(from.getTime() + 183 * 86400000);
  const entries = await Promise.all(positions.map(async ({ ticker }) => {
    const saved = previous[ticker];
    if (saved?.includesRecent && now - saved.checkedAt < 12 * 3600000) return [ticker, saved];
    try {
      const result = await marketData("InstrumentsService/GetDividends",
        { instrumentId: instrumentKey(ticker, "TQBR"),
          from: new Date(from.getTime() - 21 * 86400000).toISOString(), to: to.toISOString() }, token, ca);
      if (!Array.isArray(result.dividends)) return [ticker, saved];
      const events = result.dividends.filter(row => row.dividendType !== "Cancelled"
        && row.dividendType !== "Return of Capital" && row.dividendNet?.currency?.toLowerCase() === "rub")
        .map(row => ({
          date: row.recordDate?.slice(0, 10),
          lastBuy: row.lastBuyDate?.slice(0, 10),
          amount: Number(row.dividendNet.units ?? 0) + Number(row.dividendNet.nano ?? 0) / 1e9,
        }))
        .filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.amount > 0 && Number.isFinite(row.amount));
      return [ticker, { checkedAt: now, events, includesRecent: true }];
    } catch {
      return [ticker, saved];
    }
  }));
  return Object.fromEntries(entries.filter(([, value]) => value));
}
