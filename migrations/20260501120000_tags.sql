-- Теги источников (фидов) и связь many-to-many для фильтрации статей.

CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE feed_tags (
    feed_id INTEGER NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (feed_id, tag_id)
);

CREATE INDEX idx_feed_tags_tag_id ON feed_tags (tag_id);
