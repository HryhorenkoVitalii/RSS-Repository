# RSS Repository

RSS-агрегатор: бекенд на **Rust** (JSON API, SQLite, фоновый опрос фидов, история версий текста статей) и **веб-интерфейс** (React + TypeScript + Vite) в каталоге `frontend/`.

## Содержание

- [Требования](#требования)
- [База данных](#база-данных)
- [Запуск для разработки](#запуск)
- [Контейнер (Podman / Docker)](#контейнер-podman--docker)
- [Переменные окружения](#переменные-окружения)
- [API](#api-кратко)
- [RSS для читалок](#rss-для-читалок)
- [Структура репозитория](#структура-репозитория)
- [Стек](#стек)
- [Разработка и PR](#разработка-и-pr)

## Требования

| Режим | Что нужно |
|-------|-----------|
| Локальная разработка | **Rust** (edition 2021), **Node.js 20+** |
| Только API | Rust, файл `.env` с `DATABASE_URL` |
| Контейнер | **Podman** или **Docker**, сборка сама тянет Node и Rust внутри образа |

## База данных

```bash
cp .env.example .env
```

`DATABASE_URL=sqlite:rss_repository.db` — файл создаётся при первом запуске, миграции применяются автоматически при старте приложения.

История миграций **сведена к одному файлу** в `migrations/`. Если у тебя осталась SQLite-база от старой цепочки миграций, перед запуском удали файл БД (и при наличии `-wal` / `-shm`) либо переключись на новый путь в `DATABASE_URL`, иначе `sqlx migrate` может конфликтовать с уже существующими таблицами.

## Запуск

### API и UI вместе (разработка)

```bash
npm install
npm install --prefix frontend
npm run dev
```

Поднимаются **cargo run** (по умолчанию `0.0.0.0:8080`) и **Vite** (:5173); процесс UI ждёт `GET /api/health` перед стартом. Альтернатива: **`./scripts/dev.sh`** (после `npm install --prefix frontend`).

- В браузере: **http://127.0.0.1:5173** (или адрес из вывода Vite).
- Запросы **`/api/*`** и **`/feed.xml`** с дев-сервера проксируются на бекенд.

### Только API

```bash
cargo run
```

Полезно для интеграции без фронта или для отладки. Проверка: `curl -s http://127.0.0.1:8080/api/health`.

### Сборка статического UI (без контейнера)

```bash
cd frontend && npm install && npm run build
```

Артефакты в **`frontend/dist`**. Их нужно раздавать вместе с обратным прокси на тот же хост, что и API (`/api`, `/feed.xml` → порт Rust), иначе в браузере не будет JSON.

## Контейнер (Podman / Docker)

В образе (**`Containerfile`**) три стадии: сборка фронта (Node), сборка бинарника (Rust), финальный слой **Debian slim + nginx**.

| Компонент | Роль |
|-----------|------|
| **nginx** | Слушает **8080** (единая точка входа): отдаёт SPA из `frontend/dist`, проксирует `/api/` и `/feed.xml` на бекенд. |
| **rss-repository** | Слушает только **127.0.0.1:7878** внутри контейнера (не публикуется наружу). |
| **Volume `/data`** | Здесь лежит SQLite по умолчанию: `DATABASE_URL=sqlite:/data/rss_repository.db`. |

### Одна команда

```bash
chmod +x scripts/podman-run.sh
./scripts/podman-run.sh
```

Открой **http://127.0.0.1:8080**. Данные БД сохраняются в именованном volume **`rss-repository-data`** (можно переопределить переменной **`VOLUME`**).

Скрипт поддерживает:

| Переменная | Пример | Назначение |
|------------|--------|------------|
| `PORT` | `9000` | Проброс хоста → контейнер `:8080` (`-p $PORT:8080`) |
| `PUBLIC_BASE_URL` | `https://rss.example.org` | База для ссылок в теле `/feed.xml` (читалки и пункты RSS) |
| `VOLUME` | `my-rss-data` | Имя volume для `/data` |
| `IMAGE` | `rss-repository` | Тег образа |
| `PODMAN` | `docker` | Запуск через Docker вместо Podman |

### Вручную

```bash
podman build -t rss-repository -f Containerfile .
# или: docker build -t rss-repository -f Containerfile .

podman run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL=http://127.0.0.1:8080 \
  -v rss-repository-data:/data \
  rss-repository
```

На продакшене задай **`PUBLIC_BASE_URL`** с публичным **https://…** без завершающего слэша, чтобы ссылки в RSS вели на твой сайт.

### Логи и остановка

- Логи: `podman logs -f rss-repository` (если запускал без `--rm` и с фиксированным именем).
- Контейнер со скрипта использует имя **`rss-repository`**; если порт занят или контейнер завис, сначала: `podman stop rss-repository` или смени **`PORT`**.

**Частые проблемы (разработка):** `ERR_CONNECTION_REFUSED` на :5173 — не запущен Vite. Данные не грузятся в UI — проверь, что API слушает и отдаёт `{"ok":true}` на `/api/health`. Порт **8080** занят локально — освободи или смени **`BIND_ADDR`** / **`PORT`**.

Для ссылок в **`/feed.xml`** при dev с Vite удобно: **`PUBLIC_BASE_URL=http://127.0.0.1:5173`**. В контейнере по умолчанию скрипт передаёт `http://127.0.0.1:${PORT:-8080}`.

## Переменные окружения

| Переменная | Где задаётся | Назначение |
|------------|--------------|------------|
| `DATABASE_URL` | `.env`, контейнер | SQLite URL (**обязательно** для `cargo run`; в образе по умолчанию `sqlite:/data/rss_repository.db`) |
| `BIND_ADDR` | `.env` | Адрес прослушивания Axum (по умолчанию `0.0.0.0:8080`; в контейнере entrypoint задаёт `127.0.0.1:7878`, менять обычно не нужно) |
| `PUBLIC_BASE_URL` | `.env`, `-e` в `podman run` | Базовый URL для ссылок внутри `/feed.xml`; если пусто — берётся из заголовков запроса (`Host`, `X-Forwarded-*`) |
| `FRONTEND_ORIGIN` | `.env` | Если задана — CORS только для этого origin; иначе для API допускаются все origins |
| `RUST_LOG` | `.env`, контейнер | Фильтр логирования (`tracing`, например `info,rss_repository=debug`) |

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

`GET /feed.xml` — RSS 2.0 (до 100 пунктов). Параметры: `feed_id`, `title` (по заголовку фида; должен быть однозначным), `modified_only`, `refresh` (для одного фида по умолчанию перед отдачей выполняется опрос источника).

В UI на странице фидов есть ссылки «Open / Copy URL» на пер-фидный поток вида `/feed.xml?feed_id=…`.

При ошибке апстрима при запросе XML-слоя ответ может быть **502** с JSON-телом ошибки.

## Структура репозитория

```
├── Containerfile          # многостадийная сборка: UI + Rust + nginx
├── container/
│   ├── entrypoint.sh      # старт бекенда + nginx
│   └── nginx.conf         # статика + прокси /api и /feed.xml
├── frontend/              # Vite + React
├── migrations/            # sqlx: одна сводная миграция схемы
├── scripts/
│   ├── dev.sh             # локально: API, затем после health — Vite
│   └── podman-run.sh      # сборка образа и запуск контейнера
├── src/                   # Axum, планировщик, ингест RSS, БД
└── .env.example
```

## Стек

**Бекенд:** Axum, SQLx, Tokio, reqwest, rss, tower-http (CORS), chrono, ammonia, html-escape (нормализация текста), regex / once_cell (guid и канон текста).

**Фронтенд:** React, React Router, TypeScript, Vite, DOMPurify, библиотека `diff` (сравнение версий текста).

## Разработка и PR

```bash
cargo fmt
cargo clippy -- -D warnings
cargo build
cd frontend && npm run build
podman build -t rss-repository -f Containerfile .   # опционально
```

Перед пулл-реквестом: чистая или тестовая БД, проход миграций, smoke `cargo run` и `curl /api/health`, при необходимости проверка UI и сборки контейнера.
