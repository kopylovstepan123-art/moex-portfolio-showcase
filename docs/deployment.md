# Развёртывание своей копии

Демо и тесты запускаются локально без аккаунтов. Ниже описано развёртывание **публичного демонстрационного среза** в отдельном приватном репозитории GitHub. [Актуальная рабочая архитектура](architecture.md) использует другое расписание и дополнительную защиту кеша и webhook.

## 1. GitHub и Telegram

1. Поместите проект в приватный репозиторий с веткой `main`. Создайте ветку `bot-access` от `main`. В ней обработчик хранит зашифрованный список доступа.
2. Создайте бота через BotFather и нажмите **Start** в его личном чате. Укажите токен бота и числовой ID личного чата владельца в секретах Actions.
3. Добавьте `PORTFOLIO_JSON` с составом. Формат есть в [примере](../portfolio.example.json). `quantity` — число бумаг, `cost` — полная себестоимость позиции в рублях.
4. Запустите workflow **Доступ к Telegram-боту** с флажком `initialize_access`. Он инициализирует список доступа и проверяет меню владельца.

| Секрет GitHub Actions | Значение |
|---|---|
| `PORTFOLIO_JSON` | Конфигурация портфеля и резервный состав при недоступности брокера |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Токен отдельного бота и числовой ID личного чата владельца |
| `TELEGRAM_ACCESS_KEY` | Случайные 32 байта в base64url. Из них выводятся ключ для шифрования списка доступа и общий пароль. |
| `TELEGRAM_BRIDGE_KEY`, `TELEGRAM_WEBHOOK_SECRET` | Два независимых случайных значения по 32 байта в hex, те же значения задаются в Cloudflare |
| `TBANK_PORTFOLIO_ACCOUNT`, `TBANK_MARKET_TOKEN`, `TBANK_MARKET_CA` | Необязательно. ID счёта, токен только для чтения и корневой сертификат для HTTPS-соединения с API в base64 |
| `RUB_CASH_JSON` | Необязательный резерв рублёвого остатка в формате `{"amount":2500,"asOf":"2026-06-15T09:00:00Z"}` |
| `STOCK_COSTS_JSON`, `BOND_COSTS_JSON` | Необязательные массивы со сверенной себестоимостью. Элемент содержит `ticker` или `isin`, `quantity` и `cost` |

Для `TELEGRAM_ACCESS_KEY` используйте `randomBytes(32).toString("base64url")` из `node:crypto`. Для обоих ключей webhook используйте отдельные вызовы `randomBytes(32).toString("hex")`. Храните полученные значения в секретах соответствующих сервисов.

## 2. Webhook в Cloudflare

1. Укажите в секции `[vars]` файла `wrangler.toml` обычную переменную `GITHUB_REPOSITORY` со значением `"owner/repository"`. Workflow запускается на ветке `main`.
2. Разверните Worker командой `npx wrangler deploy`. В Cloudflare укажите секреты `TELEGRAM_BRIDGE_KEY`, `TELEGRAM_WEBHOOK_SECRET` и `GITHUB_DISPATCH_TOKEN`. Последний — fine-grained токен с правом **Actions: Read and write** на один репозиторий. Бот-токен и брокерский токен хранятся в GitHub Actions.
3. Запустите **Доступ к Telegram-боту** с параметром `webhook_url`, например `https://moex-portfolio-telegram.example.workers.dev/telegram`. Workflow проверит, что Worker может запустить обработчик, затем зарегистрирует адрес в Telegram.
4. В Actions Variables задайте `TELEGRAM_WEBHOOK_ENABLED=true`, чтобы резервный опрос пропускался. Из чата владельца проверьте `/portfolio` и `/analysis` в часы торгов.

## 3. Расписание, проверка и откат

- **Проверка демо** выполняет тесты и сравнивает вывод с [файлом примера](demo-report.md). Сетевые вызовы и токены для демо не нужны.
- **Обзор портфеля** можно запустить вручную с демонстрационными позициями. Сценарий этой версии может записать предпросмотр в GitHub Actions Summary, поэтому для проверки используйте вымышленные позиции. Флаг `send_telegram` отправляет тестовый отчёт владельцу.
- Добавьте Actions Variable `ENABLE_TELEGRAM_SCHEDULE=true`, когда готовы включить расписание. Владелец получает отчёты по будням в 07:19, 10:19, 13:19, 16:19, 19:19 и 22:19 МСК, по выходным в 10:19, 13:19 и 16:19 МСК. Гости получают последний отчёт дня.
- Чтобы вернуться к опросу команд, запустите **Доступ к Telegram-боту** с `disable_webhook=true` и удалите `TELEGRAM_WEBHOOK_ENABLED`. Для приостановки плановых запусков удалите `ENABLE_TELEGRAM_SCHEDULE`.

[Telegram Bot API](https://core.telegram.org/bots/api#setwebhook) · [Cloudflare Workers](https://developers.cloudflare.com/workers/get-started/guide/) · [GitHub Actions](https://docs.github.com/en/actions) · [MOEX ISS](https://www.moex.com/a2193) · [Т‑Инвестиции: GetPortfolio](https://developer.tbank.ru/invest/api/operations-service-get-portfolio)
