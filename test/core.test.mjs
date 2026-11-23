import assert from "node:assert/strict";
import { test } from "node:test";
import { planCommands } from "../bot-access.mjs";
import { isDailyGuestWindow } from "../market-hours.mjs";
import { openUpdate, sealUpdate } from "../telegram-bridge.mjs";
import { classifySignal } from "../stock-analysis.mjs";

const owner = "10";
const guest = "20";
const code = "a".repeat(24);
const state = { enabledAt: 1, guests: [], generation: 0 };
const update = (chat, text, id = 1) => ({
  update_id: id,
  message: {
    chat: { id: Number(chat), type: "private" },
    from: { id: Number(chat), is_bot: false },
    message_id: id, date: 20, text,
  },
});
const plan = (updates, current = state) => planCommands(updates, current, owner, () => code, 21);

test("гость получает отчёт только после входа и теряет доступ при смене пароля", () => {
  assert.deepEqual(plan([update(guest, "/portfolio")]).requests, []);
  const login = plan([update(guest, `/login ${code}`)]);
  assert.deepEqual(login.refreshMenus, [guest]);
  const commands = plan([update(guest, "/portfolio", 2), update(guest, "/analysis", 3)], login.state);
  assert.deepEqual(commands.requests, [guest]);
  assert.equal(commands.analysisRequested, false);
  const revoke = plan([update(owner, "/rotate", 4), update(guest, "/portfolio", 5)], login.state);
  assert.deepEqual(revoke.requests, []);
  assert.deepEqual(revoke.state.guests, []);
});

test("защищённое обновление не раскрывает пароль и требует правильный ключ", async () => {
  const secret = "f".repeat(64);
  const message = update(guest, `/login ${code}`);
  const sealed = await sealUpdate(message, secret);
  assert.equal(sealed.includes(code), false);
  assert.deepEqual(await openUpdate(sealed, secret), message);
  await assert.rejects(openUpdate(sealed, "0".repeat(64)));
});

test("рассылка гостям разрешена только в последнем торговом окне", () => {
  const check = value => isDailyGuestWindow(new Date(value));
  assert.equal(check("2026-06-15T22:18:00+03:00"), false);
  assert.equal(check("2026-06-15T22:19:00+03:00"), true);
  assert.equal(check("2026-06-15T23:50:00+03:00"), false);
  assert.equal(check("2026-06-21T16:19:00+03:00"), true);
  assert.equal(check("2026-06-21T19:00:00+03:00"), false);
});

test("технический сценарий учитывает среднюю цену позиции и близость отсечки", () => {
  const inputs = { trend: "Рост", histogram: 1, close: 100, short: 95, support: 80, resistance: 110, k: 70, d: 60 };
  assert.match(classifySignal({ ...inputs, entry: 95 }).label, /Докупить/);
  assert.match(classifySignal({ ...inputs, entry: 105 }).label, /Держать/);
  assert.match(classifySignal({ ...inputs, dividend: { near: true, date: "2026-06-27" } }).reason, /отсечка/);
});
