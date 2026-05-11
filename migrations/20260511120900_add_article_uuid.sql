-- Add time-ordered UUID (UUIDv7 generated in application code) to articles.
-- Stored as string to stay portable across MySQL/MariaDB without BIN_TO_UUID helpers.

ALTER TABLE articles
    ADD COLUMN uuid CHAR(36) NULL;

-- Backfill existing rows (DB-provided UUID may be v1/v4 depending on engine; OK for legacy rows).
UPDATE articles
SET uuid = UUID()
WHERE uuid IS NULL OR uuid = '';

ALTER TABLE articles
    MODIFY uuid CHAR(36) NOT NULL;

CREATE UNIQUE INDEX uk_articles_uuid ON articles (uuid);

