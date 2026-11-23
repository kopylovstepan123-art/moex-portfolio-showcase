export function createRequests({ stocks, bonds }, now = new Date()) {
  const root = "https://iss.moex.com/iss";
  const market = `${root}/engines/stock/markets`;
  const equityBoard = `${market}/shares/boards/TQBR/securities`;
  const today = new Date(now.getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);

  const stockQuotes = `${equityBoard}.json?iss.meta=off&iss.only=securities,marketdata&securities=${stocks.map(row => row.ticker).join(",")}&securities.columns=SECID,SHORTNAME,PREVPRICE&marketdata.columns=SECID,LAST,UPDATETIME,SYSTIME,TRADINGSTATUS`;
  const bondQuotes = (board, positions) => `${market}/bonds/boards/${board}/securities.json?iss.meta=off&iss.only=securities,marketdata&securities=${positions.map(row => row.isin).join(",")}&securities.columns=SECID,SHORTNAME,PREVPRICE,FACEVALUE,FACEUNIT,NEXTCOUPON&marketdata.columns=SECID,LAST,UPDATETIME,SYSTIME,TRADINGSTATUS`;
  const mainBonds = bonds.filter(row => (row.board ?? "TQCB") === "TQCB");
  const federal = bonds.filter(row => row.board === "TQOB");

  return [
    { kind: "stocks", url: stocks.length ? stockQuotes : undefined, positions: stocks, today, startedAt: now.toISOString() },
    { kind: "bonds", url: mainBonds.length ? bondQuotes("TQCB", mainBonds) : undefined, positions: bonds },
    ...(federal.length ? [{ kind: "bonds", id: "TQOB", url: bondQuotes("TQOB", federal) }] : []),
    ...bonds.map(row => ({
      kind: "coupons",
      id: row.isin,
      url: `${root}/securities/${row.isin}/bondization.json?iss.meta=off&iss.only=coupons&from=${yesterday}&limit=20`,
    })),
  ];
}

export function createAnalysisRequests(stocks, today) {
  const from = new Date(Date.parse(today) - 240 * 86400000).toISOString().slice(0, 10);
  const board = "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities";
  return stocks.map(({ ticker }) => ({
    kind: "candles",
    id: ticker,
    url: `${board}/${ticker}/candles.json?interval=24&from=${from}&till=${today}&iss.meta=off&candles.columns=begin,open,high,low,close`,
  }));
}
