-- Telegram reactions: current snapshot per article + append-only history when counts change.
CREATE TABLE article_reactions (
    article_id INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    count_display TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (article_id, emoji)
);

CREATE INDEX idx_article_reactions_article ON article_reactions (article_id);

CREATE TABLE article_reaction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    count_display TEXT NOT NULL,
    observed_at TEXT NOT NULL
);

CREATE INDEX idx_article_reaction_history_article_time
    ON article_reaction_history (article_id, observed_at DESC, id DESC);
