-- Снимки страницы (Chromium PNG) отдельно от версий article_contents.

CREATE TABLE article_screenshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    media_sha256 TEXT NOT NULL REFERENCES media (sha256),
    page_url TEXT NOT NULL,
    captured_at TEXT NOT NULL
);

CREATE INDEX idx_article_screenshots_article ON article_screenshots (article_id, captured_at DESC);
