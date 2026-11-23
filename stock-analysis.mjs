import { reportTable, rows, stockName } from "./report.mjs";

const day = 86400000;
const average = values => values.reduce((total, value) => total + value, 0) / values.length;
const price = value => value.toLocaleString("ru-RU", { maximumFractionDigits: value < 1 ? 4 : 2 });
const dateFormat = date => date.slice(8, 10) + "." + date.slice(5, 7);

function positionSummary(quantity, entry, close) {
  const holding = `${quantity.toLocaleString("ru-RU")} шт.`;
  if (!(entry > 0)) return `${holding} · средняя —`;
  const basis = `${holding} · средняя ${price(entry)} ₽`;
  if (!Number.isFinite(close)) return basis;
  const change = 100 * (close / entry - 1);
  const sign = change > 0 ? "+" : change < 0 ? "−" : "";
  return `${basis} · ${sign}${price(Math.abs(change))}% к закрытию`;
}

function ema(values, period) {
  let previous = average(values.slice(0, period));
  const result = [previous];
  const factor = 2 / (period + 1);
  for (const value of values.slice(period)) {
    previous += factor * (value - previous);
    result.push(previous);
  }
  return result;
}

function stochastic(candles) {
  const raw = candles.slice(13).map((candle, index) => {
    const window = candles.slice(index, index + 14);
    const low = Math.min(...window.map(row => row.low));
    const high = Math.max(...window.map(row => row.high));
    return high === low ? 50 : 100 * (candle.close - low) / (high - low);
  });
  const slow = raw.slice(2).map((_, index) => average(raw.slice(index, index + 3)));
  return { k: slow.at(-1), d: average(slow.slice(-3)) };
}

function completedCandles(table, today) {
  const candles = new Map();
  for (const row of table?.data ?? []) {
    const entry = Object.fromEntries(table.columns.map((column, index) => [column, row[index]]));
    const date = entry.begin?.slice(0, 10);
    if (date && date < today && [entry.open, entry.close, entry.low, entry.high].every(value => Number.isFinite(value) && value > 0)
        && entry.low <= Math.min(entry.open, entry.close) && entry.high >= Math.max(entry.open, entry.close)) {
      candles.set(date, { ...entry, date });
    }
  }
  return [...candles.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function dividendContext(entry, candles, today) {
  if (!entry?.includesRecent || Date.parse(today) - entry.checkedAt >= 48 * 3600000) return null;
  const next = entry.events.filter(event => event.date >= today && Date.parse(event.date) - Date.parse(today) <= 30 * day)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (next) {
    const before = next.lastBuy && next.lastBuy >= today ? `покупка до ${dateFormat(next.lastBuy)}, ` : "";
    const near = Date.parse(next.date) - Date.parse(today) <= 7 * day;
    return { date: next.date, near, text: `${before}реестр ${dateFormat(next.date)}, дивиденд ${price(next.amount)} ₽. ${near ? "Дождаться реакции после отсечки." : "Следить за риском гэпа."}` };
  }
  const recent = entry.events.filter(event => {
    const since = Date.parse(today) - Date.parse(event.date);
    return since >= 0 && since <= 7 * day;
  }).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (!recent) return null;
  const index = recent.lastBuy ? candles.findIndex(row => row.date > recent.lastBuy) : -1;
  const gap = index > 0 ? candles[index].open - candles[index - 1].close : null;
  const observed = gap !== null && gap < 0 ? `Разрыв на открытии −${price(-gap)} ₽. ` : "";
  return { date: recent.date, near: true, text: `Недавняя отсечка ${dateFormat(recent.date)}. ${observed}Дождаться следующего закрытия.` };
}

export function classifySignal({ trend, histogram, close, short, support, resistance, k, d, dividend, entry }) {
  if (dividend?.near) return { label: "🟡 Держать", reason: `Дивидендная отсечка ${dateFormat(dividend.date)}.` };
  if (trend === "Рост" && histogram > 0 && (close > resistance || (k < 80 && k > d))) {
    if (close < entry && close <= resistance) {
      return { label: "🟡 Держать", reason: "Позиция в минусе. Для докупки нужен пробой." };
    }
    return { label: "🟢 Докупить", reason: close > resistance ? "Пробой максимума 20 сессий." : "Тренд и импульс растут." };
  }
  if (trend === "Снижение" && histogram < 0 && close < support) {
    return { label: "🔴 Сократить", reason: "Пробой минимума 20 сессий." };
  }
  if (trend === "Снижение") return { label: "🟡 Держать", reason: `Цена ниже SMA20 (${price(short)} ₽).` };
  if (k >= 80) return { label: "🟡 Держать", reason: "Стохастик в зоне перекупленности." };
  return { label: "🟡 Держать", reason: "Индикаторы расходятся." };
}

export function buildStockAnalysis(stocks, today, responses, dividends, snapshotNotice) {
  let analyzed = 0;
  const signals = [];
  const metadata = new Map(rows(responses.get("stocks")?.securities).map(row => [row.SECID, row]));
  const details = stocks.map(({ ticker, quantity, cost }) => {
    const name = stockName(ticker, metadata.get(ticker));
    const entry = cost / quantity;
    const candles = completedCandles(responses.get(`candles:${ticker}`)?.candles, today);
    const last = candles.at(-1);
    const age = last ? Date.parse(today) - Date.parse(last.date) : Infinity;
    if (candles.length < 50 || age > 7 * day) {
      signals.push([name, "—", "Мало свежих свечей."]);
      return [name, positionSummary(quantity, entry), "—", "Нет свежей истории для сигнала."];
    }
    analyzed++;
    const closes = candles.map(row => row.close);
    const fast = ema(closes, 12);
    const macd = ema(closes, 26).map((value, index) => fast[index + 14] - value);
    const signal = ema(macd, 9);
    const histogram = macd.at(-1) - signal.at(-1);
    const short = average(closes.slice(-20));
    const long = average(closes.slice(-50));
    const { k, d } = stochastic(candles);
    const window = candles.slice(-21, -1);
    const support = Math.min(...window.map(row => row.low));
    const resistance = Math.max(...window.map(row => row.high));
    const trend = last.close > short && short > long ? "Рост" : last.close < short && short < long ? "Снижение" : "Смешанный";
    const dividend = dividendContext(dividends[ticker], candles, today);
    const trade = classifySignal({ trend, histogram, close: last.close, short, support, resistance, k, d, dividend, entry });
    signals.push([name, trade.label, trade.reason]);
    const metrics = `${trend} · ${price(last.close)} ₽ (${dateFormat(last.date)}) · SMA20/50 ${price(short)}/${price(long)} · MACD Δ ${price(histogram)} · Stoch ${Math.round(k)}/${Math.round(d)}`;
    const levels = `Уровни 20 сессий ${price(support)}–${price(resistance)} ₽.`;
    return [name, positionSummary(quantity, entry, last.close), metrics, `${levels}${dividend ? " " + dividend.text : ""}`];
  });
  if (!analyzed) return null;
  const brief = reportTable("📈 Сигналы по акциям", ["Акция", "Сигнал", "Причина"], signals);
  const full = reportTable("Позиции и индикаторы", ["Акция", "В портфеле", "Индикаторы", "Уровни и дивиденды"], details);
  const note = "Мосбиржа · завершённые дневные свечи. SMA 20/50, MACD 12/26/9, Stoch %K/%D 14/3/3.";
  const dividendNote = stocks.every(({ticker}) => dividends[ticker]?.includesRecent
    && Date.parse(today) - dividends[ticker].checkedAt < 48 * 3600000)
    ? "Дивидендный календарь Т-Инвестиций." : "Дивидендный календарь Т-Инвестиций доступен частично.";
  const notice = snapshotNotice ? `<p>${snapshotNotice}</p>` : "";
  return { html: `${notice}${brief.html}<details><summary>Полный технический отчёт</summary>${full.html}<p>${note}</p><p>${dividendNote}</p></details>`, marketActive: true };
}
