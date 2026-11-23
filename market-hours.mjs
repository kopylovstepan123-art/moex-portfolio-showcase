const moscowClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Moscow", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function marketClock(now) {
  const parts = Object.fromEntries(moscowClock.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    weekend: parts.weekday === "Sat" || parts.weekday === "Sun",
  };
}

export function inMarketHours(now = new Date()) {
  const { minute, weekend } = marketClock(now);
  return weekend ? minute >= 590 && minute < 1140 : minute >= 410 && minute < 1430;
}

export function isDailyGuestWindow(now = new Date()) {
  const { minute, weekend } = marketClock(now);
  return minute >= (weekend ? 16 : 22) * 60 + 19 && inMarketHours(now);
}
