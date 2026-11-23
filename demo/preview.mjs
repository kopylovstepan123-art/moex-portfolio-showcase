import { readFileSync } from "node:fs";
import { buildReport } from "../report.mjs";
import { createRequests } from "../requests.mjs";

const portfolio = JSON.parse(readFileSync(new URL("../portfolio.example.json", import.meta.url), "utf8"));
const now = new Date("2026-06-15T12:00:00+03:00");
const tradeTime = ["11:45:00", "2026-06-15 12:00:00", "T"];
const marketColumns = ["SECID", "LAST", "UPDATETIME", "SYSTIME", "TRADINGSTATUS"];
const bond = portfolio.bonds[0].isin;
const responses = new Map([
  ["stocks", {
    securities: {
      columns: ["SECID", "SHORTNAME", "PREVPRICE"],
      data: [["LKOH", "Лукойл", 6060], ["YDEX", "Яндекс", 3890]],
    },
    marketdata: { columns: marketColumns, data: [["LKOH", 6120, ...tradeTime], ["YDEX", 3850, ...tradeTime]] },
  }],
  ["bonds:TQOB", {
    securities: {
      columns: ["SECID", "PREVPRICE", "FACEVALUE", "FACEUNIT", "NEXTCOUPON"],
      data: [[bond, 91.1, 1000, "RUB", "2026-06-22"]],
    },
    marketdata: { columns: marketColumns, data: [[bond, 91.3, ...tradeTime]] },
  }],
  [`coupons:${bond}`, {
    coupons: { columns: ["coupondate", "value_rub"], data: [["2026-06-22", 38.15], ["2026-12-21", 38.15]] },
  }],
]);

const report = buildReport({
  requests: createRequests(portfolio, now),
  responses,
  cash: { amount: 5000, asOf: now.toISOString() },
  manual: true,
});

console.log("# Пример отчёта\n\nВымышленные позиции и цены. Пример работает без сети и токенов.\n\n" + report.preview);
