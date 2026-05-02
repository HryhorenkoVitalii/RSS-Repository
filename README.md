# RSS Repository

RSS-агрегатор: бекенд на **Rust** (JSON API, MariaDB/MySQL, фоновый опрос фидов, история версий текста статей) и **веб-интерфейс** (React + TypeScript + Vite) в каталоге `frontend/`.

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
| Только API | Rust, файл `.env` с `DATABASE_URL` (MySQL/MariaDB) |
| Контейнер | **Podman** или **Docker**, сборка сама тянет Node и Rust внутри образа |

## База данных

```bash
cp .env.example .env
```

`DATABASE_URL` — URL вида `mysql://user:password@host:3306/database_name`. Миграции применяются автоматически при старте приложения.

Схема описана **одним файлом** `migrations/20260424120000_squashed_schema.sql`. Если таблицы уже созданы другой версией миграций, очистите базу или используйте новое имя БД.

Все **записи** в БД дополнительно сериализуются одним семафором (чтения идут параллельно).

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
| **Каталог `/data`** | Монтируется для **`MEDIA_DIR=/data/media`**. База — контейнер **MariaDB** в том же Compose-проекте (том `mariadb_data`), сеть только между сервисами стека. |

### Compose (рекомендуется)

Нужен **Docker Compose v2** (`docker compose`) или **Podman Compose** (`podman compose`).

```bash
chmod +x scripts/podman-run.sh
./scripts/podman-run.sh
```

Либо из корня репозитория:

```bash
docker compose up -d --build
# или: podman compose up -d --build
```

Файл **`compose.yaml`**: проект с именем **`rss-repository`**, отдельная сеть для сервисов **`db`** и **`app`**. **Порт 3306 у MariaDB на хост не пробрасывается** — к БД извне не подключиться, только приложение обращается к хосту **`db`**. Наружу открыт только **`PORT`** (по умолчанию **8080**) у приложения.

Открой **http://127.0.0.1:8080**. **Порт 5173** — только у **`npm run dev`** (Vite).

Остановка и тома:

```bash
docker compose down          # контейнеры
docker compose down -v       # + удалить том MariaDB (чистая БД)
```

Параметры задаются через **`.env`** в корне репозитория или переменные окружения (см. таблицу).

| Переменная | Пример | Назначение |
|------------|--------|------------|
| `HOST_DATA_DIR` | `./data` или абсолютный путь | Каталог на хосте → `/data` в приложении |
| `MARIADB_*` | см. `compose.yaml` | Имя БД, пользователь, пароли MariaDB |
| `PORT` | `9000` | Проброс `хост:$PORT` → `app:8080` |
| `PUBLIC_BASE_URL` | `https://rss.example.org` | Ссылки в `/feed.xml`; при смене `PORT` задайте URL с нужным портом |
| `RSS_IMAGE` | `rss-repository:local` | Тег собранного образа приложения |
| `COMPOSE_CMD` | `podman compose` | Явно указать команду Compose |
| `COMPOSE_UP_FLAGS` | `--build` | Флаги для `compose up` (по умолчанию `-d --build`) |

### Вручную

Поднимите MariaDB (или используйте облачный MySQL), затем передайте **`DATABASE_URL`** и при необходимости **`MEDIA_DIR`**:

```bash
mkdir -p ./data/media
podman build -t rss-repository -f Containerfile .
# или: docker build -t rss-repository -f Containerfile .

podman run --rm -p 8080:8080 \
  -e PUBLIC_BASE_URL=http://127.0.0.1:8080 \
  -e DATABASE_URL='mysql://user:pass@host:3306/rss_repository' \
  -e MEDIA_DIR=/data/media \
  -v "$(pwd)/data:/data" \
  rss-repository
```

На продакшене задай **`PUBLIC_BASE_URL`** с публичным **https://…** без завершающего слэша, чтобы ссылки в RSS вели на твой сайт.

### Логи и остановка (Compose)

- Логи: `docker compose logs -f app` / `docker compose logs -f db` (или `podman compose …`).
- Остановка: `docker compose down` в каталоге с **`compose.yaml`**.

**Частые проблемы (разработка):** `ERR_CONNECTION_REFUSED` на :5173 — не запущен Vite. Данные не грузятся в UI — проверь **`GET /api/health`**: **`ok`** и **`database`** = `ok` (и при необходимости **`media_dir`**). Порт **8080** занят — смени **`PORT`** в `.env` или окружении.

Для ссылок в **`/feed.xml`** при dev с Vite удобно: **`PUBLIC_BASE_URL=http://127.0.0.1:5173`**. В Compose задайте **`PUBLIC_BASE_URL`** в `.env` (по умолчанию в **`compose.yaml`**: `http://127.0.0.1:8080`).

## Переменные окружения

| Переменная | Где задаётся | Назначение |
|------------|--------------|------------|
| `DATABASE_URL` | `.env`, `-e` в `podman run` | MySQL/MariaDB URL (**обязательно**), например `mysql://user:pass@host:3306/dbname` |
| `BIND_ADDR` | `.env` | Адрес прослушивания Axum (по умолчанию `0.0.0.0:8080`; в контейнере entrypoint задаёт `127.0.0.1:7878`, менять обычно не нужно) |
| `PUBLIC_BASE_URL` | `.env`, `-e` в `podman run` | Базовый URL для ссылок внутри `/feed.xml`; если пусто — берётся из заголовков запроса (`Host`, `X-Forwarded-*`) |
| `FRONTEND_ORIGIN` | `.env` | Если задана — CORS только для этого origin; иначе для API допускаются все origins |
| `RUST_LOG` | `.env`, контейнер | Фильтр логирования (`tracing`, например `info,rss_repository=debug`) |
| `SCHEDULER_TICK_SECS` | `.env` | Базовый интервал тика планировщика (по умолчанию 10; к нему добавляется jitter до 25%) |
| `SCHEDULER_MAX_FEEDS_PER_TICK` | `.env` | Максимум due-фидов, обрабатываемых за один тик (по умолчанию 25) |
| `HTTP_RETRY_MAX_ATTEMPTS` | `.env` | Повторы исходящего GET при 408/429/5xx и сетевых ошибках (1–8, по умолчанию 3) |
| `HTTP_RETRY_BASE_MS` | `.env` | Базовая задержка backoff в мс (50–10000, по умолчанию 300) |

## API (кратко)

| Метод | Путь | Описание |
|--------|------|----------|
| GET | `/api/health` | Живость БД (`ok`, `database`); каталог медиа (`media_dir`, не влияет на `ok`) |
| GET | `/api/openapi.json` | Черновой OpenAPI 3.0 (список основных путей) |
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
├── src/                   # `lib.rs` (логика + тесты), `main.rs` (тонкий вход), Axum, БД в `db/`
├── tests/                 # интеграционные тесты роутера (SQLite in-memory + миграции)
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
