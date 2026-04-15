-- When set, RSS items with very little body text are fetched from item.link and main HTML is stored.
ALTER TABLE feeds ADD COLUMN expand_article_from_link INTEGER NOT NULL DEFAULT 0;
