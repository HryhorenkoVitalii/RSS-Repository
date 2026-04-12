-- Squashed schema: feeds, articles, article_contents, request_log, media.
-- Если база уже создавалась старыми миграциями (другие имена в `_sqlx_migrations`),
-- удали файл БД (и `-wal` / `-shm`) или очисти `_sqlx_migrations` и таблицы.

CREATE TABLE feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    title TEXT,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 600 CHECK (poll_interval_seconds >= 60 AND poll_interval_seconds <= 86400),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_polled_at TEXT
);

CREATE TABLE articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_id INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    published_at TEXT,
    first_seen_at TEXT NOT NULL,
    last_fetched_at TEXT NOT NULL,
    UNIQUE (feed_id, guid)
);

CREATE INDEX idx_articles_feed_id ON articles (feed_id);
CREATE INDEX idx_articles_last_fetched ON articles (last_fetched_at DESC);

CREATE TABLE article_contents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    content_hash BLOB NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);

CREATE INDEX idx_article_contents_article_id ON article_contents (article_id);

CREATE TABLE request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
);

CREATE INDEX idx_request_log_requested_at ON request_log (requested_at DESC);

CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL UNIQUE,
    original_url TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_media_sha256 ON media (sha256);
