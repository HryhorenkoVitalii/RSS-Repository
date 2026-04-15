-- Max posts to fetch from Telegram preview per poll (1–500). RSS feeds ignore this value.
ALTER TABLE feeds ADD COLUMN telegram_max_items INTEGER NOT NULL DEFAULT 500;
