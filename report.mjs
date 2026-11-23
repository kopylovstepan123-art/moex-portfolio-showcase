const stockNames = {
  LKOH: "Лукойл",
  YDEX: "Яндекс",
};

export const stockName = (ticker, metadata) => stockNames[ticker] ?? metadata?.SHORTNAME ?? ticker;

const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeMarkdown = value => escapeHtml(value).replace(/[\\|`*_~[\]]/g, "\\$&");
const msk = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short",
});
const number = (value, decimals = 2) => value.toLocaleString("ru-RU", { maximumFractionDigits: decimals });
const signed = (value, decimals = 2) => (value > 0 ? "+" : value < 0 ? "−" : "") + number(Math.abs(value), decimals);
const price = value => number(value, value < 1 ? 4 : 3);
const move = (latest, base) => Number.isFinite(base) && base > 0 ? 100 * (latest / base - 1) : null;
const percent = value => value === null ? "—" : `${signed(value)}%`;
const valid = value => typeof value === "number" && Number.isFinite(value);
const positive = value => valid(value) && value > 0;

export function rows(table) {
  return table?.data?.map(row => Object.fromEntries(table.columns.map((key, i) => [key, row[i]]))) ?? [];
}

function quoteMeta(row, { today, startedAt }) {
  const minute = 60000;
  const date = row?.SYSTIME?.slice(0, 10);
  const sampledAt = Date.parse(startedAt);
  const snapshot = date && row.UPDATETIME ? Date.parse(`${date}T${row.UPDATETIME}+03:00`) : NaN;
  return {
    current: date === today && Number.isFinite(snapshot) && sampledAt - snapshot < 45 * minute
      && snapshot - sampledAt < 2 * minute,
    snapshot,
  };
}

function htmlRow(row, bold = false) {
  return `<tr>${row.map((cell, column) => {
    const text = escapeHtml(cell);
    return `<td align="${column === 0 ? "left" : "right"}">${bold && text ? `<b>${text}</b>` : text}</td>`;
  }).join("")}</tr>`;
}

export function reportTable(title, headers, rows, totals = []) {
  const header = headers.map(cell => `<th>${escapeHtml(cell)}</th>`).join("");
  const body = rows.map(row => htmlRow(row)).join("");
  const footer = totals.map(row => htmlRow(row, true)).join("");
  const html = `<table bordered striped compact><tr>${header}</tr>${body}${footer}</table>`;
  const markdownRow = row => `| ${row.map(escapeMarkdown).join(" | ")} |`;
  const markdown = [markdownRow(headers), markdownRow(headers.map((_, i) => i ? "---:" : "---")),
    ...rows.map(markdownRow), ...totals.map(markdownRow)].join("\n");
  return {
    html: `<h4>${escapeHtml(title)}</h4>${html}`,
    markdown: `### ${title}\n\n${markdown}`,
  };
}

export function buildReport({ requests, responses, previous = {}, manual = false, cash, broker, dividends, trackHistory = false, snapshotNotice }) {
  const stockRequest = requests[0];
  const { positions: stocks, today, startedAt } = stockRequest;
  const bonds = requests[1].positions;
  const sampledAt = Date.parse(startedAt);
  const [year, month] = today.split("-").map(Number);
  const monthName = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", month: "long" });
  const monthStarts = [today, new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10)];
  const couponPeriods = monthStarts.map((from, index) => ({
    from,
    until: new Date(Date.UTC(year, month + index, 1)).toISOString().slice(0, 10),
    name: monthName.format(Date.parse(from)),
    amount: 0, known: 0, incomplete: false,
  }));
  const state = {
    coupons: { ...previous.coupons },
    bondMoves: { ...previous.bondMoves },
    issues: previous.issues ?? "",
  };

  const stockBook = responses.get("stocks");
  const stockQuotes = new Map(rows(stockBook?.marketdata).map(row => [row.SECID, row]));
  const stockMeta = new Map(rows(stockBook?.securities).map(row => [row.SECID, row]));
  const bondBooks = [responses.get("bonds"), responses.get("bonds:TQOB")];
  const bondQuotes = new Map(bondBooks.flatMap(book => rows(book?.marketdata).map(row => [row.SECID, row])));
  const bondMeta = new Map(bondBooks.flatMap(book => rows(book?.securities).map(row => [row.SECID, row])));
  const tradesOpen = quotes => [...quotes.values()].some(row => quoteMeta(row, stockRequest).current && row.TRADINGSTATUS === "T");
  const equitySession = broker?.stocksActive ?? tradesOpen(stockQuotes);
  const bondSession = broker?.bondsActive ?? tradesOpen(bondQuotes);

  const stockRows = [];
  const quotesMissing = [];
  let brokerQuotesUsed = 0;
  let stockValue = 0;
  let stockCost = 0;
  let stockValueWithCost = 0;
  let stocksWithCost = 0;
  let freshStocks = 0;
  let hasClosingPrice = false;

  function latestQuote(key, market, previousClose) {
    const exchange = quoteMeta(market, stockRequest);
    const current = positive(market?.LAST) && exchange.current;
    const live = broker?.prices.get(key);
    if (live && sampledAt - live.snapshot < 45 * 60000 && live.snapshot - sampledAt < 2 * 60000
        && (!current || live.snapshot > exchange.snapshot)) {
      brokerQuotesUsed++;
      return { quote: live.amount, current: true };
    }
    return { quote: current ? market.LAST : previousClose, current };
  }

  for (const stock of stocks) {
    const market = stockQuotes.get(stock.ticker);
    const metadata = stockMeta.get(stock.ticker);
    const name = stockName(stock.ticker, metadata);
    const { quote, current } = latestQuote(`${stock.ticker}_TQBR`, market, metadata?.PREVPRICE);
    const quantity = number(stock.quantity, 0);
    if (!positive(quote)) {
      quotesMissing.push(stock.ticker);
      stockRows.push([name, quantity, "—", "—", "—"]);
      continue;
    }
    if (current) freshStocks++;
    else hasClosingPrice = true;
    const value = quote * stock.quantity;
    const knownCost = positive(stock.cost);
    stockRows.push([name, quantity, price(quote) + (current ? "" : "*"),
      current ? percent(move(quote, metadata?.PREVPRICE)) : "—", knownCost ? signed(value - stock.cost) : "—"]);
    stockValue += value;
    if (knownCost) {
      stockCost += stock.cost;
      stockValueWithCost += value;
      stocksWithCost++;
    }
  }

  const couponIssues = [];
  const bondRows = [];
  const bondAlerts = [];
  let bondValue = 0;
  let bondsValued = 0;
  let hasCouponAlert = false;
  let hasCouponChange = false;
  for (const bond of bonds) {
    const market = bondQuotes.get(bond.isin);
    const metadata = bondMeta.get(bond.isin);
    const bondName = bond.name === bond.isin ? metadata?.SHORTNAME ?? bond.name : bond.name;
    const payments = rows(responses.get(`coupons:${bond.isin}`)?.coupons)
      .map(row => ({ date: row.coupondate, amount: positive(row.value_rub) ? row.value_rub : null }))
      .filter(payment => payment.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    const next = payments[0];
    const scheduledDate = next?.date ?? metadata?.NEXTCOUPON;
    const date = scheduledDate >= today ? scheduledDate : null;
    const amount = next?.amount ?? null;
    for (const period of couponPeriods) {
      for (const payment of payments) {
        if (payment.date >= period.until) break;
        if (payment.date < period.from) continue;
        if (payment.amount === null) {
          period.incomplete = true;
        } else {
          period.amount += payment.amount * bond.quantity;
          period.known++;
        }
      }
      if (!next && (!date || date < period.until)) period.incomplete = true;
    }
    let changed = false;
    if (next) {
      const signature = `${date}|${amount ?? "unknown"}`;
      const withinWeek = (Date.parse(date) - Date.parse(today)) / 86400000 <= 7;
      const prior = previous.coupons?.[bond.isin];
      changed = Boolean(prior && prior.signature !== signature && prior.date >= today);
      const notify = changed || (withinWeek && prior?.notified !== signature);
      hasCouponAlert ||= notify;
      hasCouponChange ||= changed;
      state.coupons[bond.isin] = { signature, date, notified: notify ? signature : prior?.notified };
    } else {
      couponIssues.push(bond.name);
    }

    const { quote, current } = latestQuote(`${bond.isin}_${bond.board ?? "TQCB"}`, market, metadata?.PREVPRICE);
    const rubleNominal = ["SUR", "RUB"].includes(metadata?.FACEUNIT) && positive(metadata?.FACEVALUE);
    let bondPrice = "—";
    if (positive(quote)) {
      if (rubleNominal) {
        const unitPrice = quote * metadata.FACEVALUE / 100;
        bondPrice = `${number(unitPrice)} ₽`;
        bondValue += unitPrice * bond.quantity;
        bondsValued++;
      } else {
        bondPrice = `${number(quote)}%`;
      }
      if (!current) {
        bondPrice += "*";
        hasClosingPrice = true;
      }
    }
    bondRows.push({
      date,
      cells: [
        changed ? `🔔 ${bondName}` : bondName, number(bond.quantity, 0),
        bondPrice, amount === null ? "—" : number(amount * bond.quantity),
        date ? `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(2, 4)}` : "—",
      ],
    });
    if (!current) continue;
    const delta = move(quote, metadata?.PREVPRICE);
    const priorAlert = previous.bondMoves?.[bond.isin];
    const alreadyReported = priorAlert?.date === today && Math.sign(priorAlert.delta) === Math.sign(delta)
      && Math.abs(delta) < Math.abs(priorAlert.delta) + 1;
    if (delta === null || Math.abs(delta) < 3 - 1e-9 || alreadyReported) continue;
    bondAlerts.push(`${bondName} ${percent(delta)}`);
    state.bondMoves[bond.isin] = { date: today, delta };
  }

  const missing = [
    quotesMissing.length ? `Котировки: ${quotesMissing.join(", ")}` : "",
    couponIssues.length ? `Купоны: ${couponIssues.join(", ")}` : "",
    bondsValued < bonds.length ? "Котировки облигаций" : "",
  ].filter(Boolean).join(". ");
  const newIssue = Boolean(missing && missing !== previous.issues);
  state.issues = missing;

  const shouldNotify = Boolean(equitySession || hasCouponAlert || bondAlerts.length || newIssue);
  const title = `📊 Портфель · ${msk.format(sampledAt)} мск`;
  const parts = [{ html: `<p>${escapeHtml(title)}</p>`, markdown: title }];
  const addLine = (line, bold = false) => parts.push(bold
    ? { html: `<p><b>${escapeHtml(line)}</b></p>`, markdown: `**${escapeMarkdown(line)}**` }
    : { html: `<p>${escapeHtml(line)}</p>`, markdown: escapeMarkdown(line) });
  const stocksValued = stocks.length - quotesMissing.length;
  const valuation = (value, covered, size) => {
    if (!covered && size) return "—";
    const coverage = covered < size ? ` · ${covered}/${size} поз.` : "";
    return `${number(value)} ₽${coverage}`;
  };
  const stocksTotal = valuation(stockValue, stocksValued, stocks.length);
  const bondsTotal = valuation(bondValue, bondsValued, bonds.length);
  const securitiesValue = stockValue + bondValue;
  const valued = stocksValued + bondsValued;
  const positions = stocks.length + bonds.length;
  const cashDate = typeof cash?.asOf === "string" ? Date.parse(cash.asOf) : NaN;
  const hasCash = valid(cash?.amount) && Number.isFinite(cashDate);
  const portfolioTotal = valued || hasCash
    ? `${number(securitiesValue + (hasCash ? cash.amount : 0))} ₽${valued < positions ? ` · бумаги ${valued}/${positions}` : ""}`
    : "—";
  const formatResult = (value, cost, label) => {
    const pnl = value - cost;
    const marker = pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
    return `${marker} ${label} ${signed(pnl)} ₽ (${percent(move(value, cost))})`;
  };
  const total = `${hasCash ? "Всего" : "Всего по бумагам"} ${portfolioTotal}`;
  const breakdown = [
    ["📈 Акции", stocksTotal],
    ["💵 Облигации", bondsTotal],
    ["💰 Деньги", hasCash ? `${number(cash.amount)} ₽` : "—"],
  ];
  parts.push({ html: `<h2>${escapeHtml(total)}</h2>`, markdown: `## ${total}` });
  parts.push({
    html: `<table compact>${breakdown.map(row => htmlRow(row)).join("")}</table>`,
    markdown: breakdown.map(([label, amount]) => `${label} · ${amount}`).join("<br>\n"),
  });
  const hasBondCosts = bonds.every(bond => positive(bond.cost));
  if (stocksWithCost === stocks.length && bondsValued === bonds.length && hasBondCosts && positions) {
    const totalCost = bonds.reduce((sum, bond) => sum + bond.cost, stockCost);
    addLine(formatResult(securitiesValue, totalCost, "Результат"), true);
  } else if (stockCost > 0) {
    const scope = stocksWithCost < stocks.length ? "Результат акций (доступные)" : "Результат акций";
    addLine(formatResult(stockValueWithCost, stockCost, scope), true);
  } else {
    addLine("Результат —");
  }
  if (snapshotNotice) addLine(snapshotNotice);
  if (trackHistory) {
    const history = new Map();
    const saved = (previous.valuationHistory ?? [])
      .filter(point => valid(point.at) && valid(point.value) && point.at <= sampledAt && sampledAt - point.at <= 30 * 86400000)
      .sort((a, b) => a.at - b.at);
    for (const point of saved) {
      const date = new Date(point.at + 3 * 3600000).toISOString().slice(0, 10);
      if (!history.has(date)) history.set(date, point);
    }
    if (!history.has(today) && hasCash && positions && valued === positions && (equitySession || bondSession)) {
      history.set(today, { at: sampledAt, value: securitiesValue + cash.amount });
    }
    state.valuationHistory = [...history.values()].slice(-30);
    const points = state.valuationHistory;
    if (points.length > 1) {
      const values = points.map(point => point.value);
      const low = Math.min(...values);
      const high = Math.max(...values);
      const spark = values.map(value => "▁▂▃▄▅▆▇█"[high === low ? 3 : Math.round(7 * (value - low) / (high - low))]).join("");
      const first = points[0];
      const last = points.at(-1);
      const range = `${msk.format(first.at)} → ${msk.format(last.at)} · ${signed(last.value - first.value)} ₽`;
      parts.push({
        html: `<p><b>📊 Стоимость по дням</b></p><pre>${spark}</pre><p>${escapeHtml(range)}</p>`,
        markdown: `**📊 Стоимость по дням**\n\n${spark}\n\n${range}`,
      });
    } else {
      addLine("📊 График появится после двух сопоставимых снимков.");
    }
  }
  if (stocks.length) parts.push(reportTable(`📈 Акции (${stocksTotal})`, ["Компания", "Кол-во", "Цена, ₽", "День", "К покупке, ₽"], stockRows));
  if (dividends) {
    const available = stocks.filter(({ ticker }) => sampledAt - (dividends[ticker]?.checkedAt ?? 0) < 48 * 3600000);
    const events = available.flatMap(({ ticker, quantity }) => dividends[ticker].events
      .filter(event => event.date >= today)
      .map(event => ({ ...event, name: stockNames[ticker] ?? ticker, total: event.amount * quantity })))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (events.length) {
      parts.push(reportTable("💸 Ожидаемые дивиденды", ["Акция", "Реестр", "На позицию, ₽"],
        events.map(event => [event.name, event.date, number(event.total)])));
    }
    if (available.length < stocks.length) addLine(`Данные по дивидендам доступны для ${available.length}/${stocks.length} акций.`);
    else if (!events.length) addLine("💸 По календарю Т-Инвестиций будущих отсечек пока нет.");
  }
  if (bondRows.length) {
    bondRows.sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999"));
    const shortDate = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
    const couponTotals = couponPeriods.map(period => {
      const lastDay = new Date(Date.parse(period.until) - 86400000).toISOString();
      const amount = period.incomplete && !period.known ? "—" : number(period.amount);
      return [`Купоны · ${period.name}${period.incomplete ? "*" : ""}`, "", "", amount,
        `${shortDate(period.from)}–${shortDate(lastDay)}`];
    });
    parts.push(reportTable(`💵 Облигации (${bondsTotal})`, ["Выпуск", "Кол-во", "Цена", "Купон, ₽", "Дата"],
      bondRows.map(row => row.cells), couponTotals));
    const baseline = couponPeriods[1];
    if (!baseline.incomplete && baseline.known) {
      const annualAmount = baseline.amount * 12;
      const annualYield = hasBondCosts
        ? ` · ${number(100 * annualAmount / bonds.reduce((sum, bond) => sum + bond.cost, 0))}% годовых`
        : "";
      addLine(`📆 Прогноз при той же ключевой ставке · ≈ ${number(annualAmount)} ₽ в год${annualYield}`, true);
      addLine("Без учета погашения облигации по номиналу и налогов", true);
    }
    if (couponPeriods.some(period => period.incomplete)) addLine("* Часть сумм пока неизвестна.");
  }
  if (hasClosingPrice) addLine("* Цена прошлого закрытия.");
  if (hasCouponChange) addLine("🔔 Изменились дата или сумма купона.");
  if (bondAlerts.length) addLine(`⚡ Облигации за день · ${bondAlerts.join(" · ")}`);
  if (newIssue || (manual && missing)) {
    addLine("⚠️ Часть данных Мосбиржи недоступна.");
  }
  return {
    html: parts.map(part => part.html).join("\n"),
    preview: parts.map(part => part.markdown).join("\n\n"),
    state,
    shouldNotify,
    marketActive: equitySession || bondSession,
    availableStocks: freshStocks,
    pricedPositions: valued,
    brokerQuotesUsed,
  };
}
