-- MariaDB / MySQL (InnoDB). UTF-8 для имён тегов и без учёта регистра там, где нужно.

SET NAMES utf8mb4;

CREATE TABLE feeds (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    url VARCHAR(2048) NOT NULL,
    title VARCHAR(512) NULL,
    poll_interval_seconds INT NOT NULL DEFAULT 600,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_polled_at DATETIME(3) NULL,
    telegram_max_items INT NOT NULL DEFAULT 500,
    expand_article_from_link TINYINT(1) NOT NULL DEFAULT 0,
    CONSTRAINT chk_feed_poll CHECK (poll_interval_seconds >= 60 AND poll_interval_seconds <= 86400),
    CONSTRAINT chk_feed_tg CHECK (telegram_max_items >= 1 AND telegram_max_items <= 500),
    UNIQUE KEY uk_feeds_url (url(512))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE articles (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    feed_id BIGINT NOT NULL,
    guid VARCHAR(4096) NOT NULL,
    published_at DATETIME(3) NULL,
    first_seen_at DATETIME(3) NOT NULL,
    last_fetched_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_articles_feed FOREIGN KEY (feed_id) REFERENCES feeds (id) ON DELETE CASCADE,
    UNIQUE KEY uk_articles_feed_guid (feed_id, guid(512))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_articles_feed_id ON articles (feed_id);
CREATE INDEX idx_articles_last_fetched ON articles (last_fetched_at DESC);

CREATE TABLE article_contents (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    article_id BIGINT NOT NULL,
    content_hash BLOB NOT NULL,
    title TEXT NOT NULL,
    body LONGTEXT NOT NULL,
    fetched_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_article_contents_article FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_article_contents_article_id ON article_contents (article_id);

CREATE TABLE request_log (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    method VARCHAR(16) NOT NULL,
    path VARCHAR(2048) NOT NULL,
    status_code INT NOT NULL,
    duration_ms INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_request_log_requested_at ON request_log (requested_at DESC);

CREATE TABLE media (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sha256 CHAR(64) NOT NULL,
    original_url VARCHAR(4096) NOT NULL,
    mime_type VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    file_size BIGINT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_media_sha256 (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_media_sha256 ON media (sha256);

CREATE TABLE article_reactions (
    article_id BIGINT NOT NULL,
    emoji VARCHAR(64) NOT NULL,
    count_display VARCHAR(64) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (article_id, emoji),
    CONSTRAINT fk_article_reactions_article FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_article_reactions_article ON article_reactions (article_id);

CREATE TABLE article_reaction_history (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    article_id BIGINT NOT NULL,
    emoji VARCHAR(64) NOT NULL,
    count_display VARCHAR(64) NOT NULL,
    observed_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_article_reaction_history_article FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_article_reaction_history_article_time
    ON article_reaction_history (article_id, observed_at DESC, id DESC);

CREATE TABLE article_screenshots (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    article_id BIGINT NOT NULL,
    media_sha256 CHAR(64) NOT NULL,
    page_url VARCHAR(4096) NOT NULL,
    captured_at DATETIME(3) NOT NULL,
    CONSTRAINT fk_article_screenshots_article FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE,
    CONSTRAINT fk_article_screenshots_media FOREIGN KEY (media_sha256) REFERENCES media (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_article_screenshots_article ON article_screenshots (article_id, captured_at DESC);

CREATE TABLE tags (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL,
    color VARCHAR(16) NOT NULL DEFAULT '#64748b',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_tags_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE feed_tags (
    feed_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,
    PRIMARY KEY (feed_id, tag_id),
    CONSTRAINT fk_feed_tags_feed FOREIGN KEY (feed_id) REFERENCES feeds (id) ON DELETE CASCADE,
    CONSTRAINT fk_feed_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_feed_tags_tag_id ON feed_tags (tag_id);
