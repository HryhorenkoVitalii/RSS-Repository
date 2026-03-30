# RSS Repository

RSS-агрегатор: бекенд на **Rust** (JSON API, SQLite, фоновый опрос, история версий текста) и **веб-интерфейс** (React + TypeScript + Vite) в каталоге `frontend/`.

## Требования

- Rust (edition 2021), **Node.js 20+** (для UI)

## База данных

```bash
cp .env.example .env
```

`DATABASE_URL=sqlite:rss_repository.db` — файл создаётся при первом запуске, миграции применяются автоматически.

История миграций **сведена к одному файлу** в `migrations/`. Если у тебя осталась SQLite-база от старой цепочки миграций, перед запуском удали файл БД (и при наличии `-wal` / `-shm`) либо переключись на новый путь в `DATABASE_URL`, иначе `sqlx migrate` может конфликтовать с уже существующими таблицами.

## Запуск

**API и UI вместе:**

```bash
npm install
npm install --prefix frontend
npm run dev
```

Поднимаются **cargo run** (:8080) и **Vite** (:5173); UI ждёт `GET /api/health` перед стартом. Альтернатива: **`./scripts/dev.sh`** (нужен `npm install --prefix frontend`).

В браузере: **http://127.0.0.1:5173** (или URL из вывода Vite). Прокси: `/api`, `/feed.xml` → :8080.

Только API:

```bash
cargo run
```

**Частые проблемы:** `ERR_CONNECTION_REFUSED` на :5173 — не запущен Vite. Данные не грузятся — проверь `curl -s http://127.0.0.1:8080/api/health`. Порт **8080** занят — освободи или смени `BIND_ADDR`.

Для ссылок в **`/feed.xml`** при разработке с SPA: **`PUBLIC_BASE_URL=http://127.0.0.1:5173`**.

### Сборка UI

```bash
cd frontend && npm install && npm run build
```

Отдавай `frontend/dist` через статический хост с прокси `/api` и `/feed.xml` на Rust-сервер.

### Переменные окружения

| Переменная | Назначение |
|------------|------------|
| `DATABASE_URL` | SQLite URL (обязательно) |
| `BIND_ADDR` | Адрес прослушивания |
| `PUBLIC_BASE_URL` | База для ссылок внутри `/feed.xml` (если не задана — из заголовков запроса) |
| `FRONTEND_ORIGIN` | Задана — CORS только для этого origin; иначе допускаются все origins |

## API (кратко)

| Метод | Путь | Описание |
|--------|------|----------|
| GET | `/api/health` | Проверка живости |
| GET | `/api/feeds?page=` | Фиды (пагинация, 20 на страницу) |
| GET | `/api/feeds/options` | `id` / `url` / `title` для фильтров (лёгкий ответ) |
| POST | `/api/feeds` | JSON `{ "url", "poll_interval_seconds" }` |
| POST | `/api/feeds/{id}/interval` | JSON `{ "poll_interval_seconds" }` |
| POST | `/api/feeds/{id}/poll` | Ручной опрос (202) |
| POST | `/api/feeds/poll-all` | Опрос всех (202) |
| GET | `/api/articles` | Список статей (50 на страницу) |
| GET | `/api/articles/{id}` | Статья и `versions[]` |

**Query для `/api/articles`:** `feed_id`, `modified_only` (`true` / `1`), `page`, `date_from`, `date_to` (`YYYY-MM-DD`, фильтр по `last_fetched_at`).

Ошибки: JSON `{ "error": "..." }`.

## RSS для читалок

`GET /feed.xml` — RSS 2.0 (до 100 пунктов). Параметры: `feed_id`, `title` (по заголовку фида), `modified_only`, `refresh`.

## Стек

**Бекенд:** Axum, SQLx, Tokio, reqwest, rss, tower-http (CORS), chrono, ammonia.  
**Фронтенд:** React, React Router, TypeScript, Vite, DOMPurify, `diff`.

## Разработка и PR

```bash
cargo fmt
cargo clippy -- -D warnings
cargo build
cd frontend && npm run build
```

Перед пулл-реквестом: чистая или тестовая БД + миграции, smoke `cargo run`, `curl /api/health`, ручная проверка UI.
