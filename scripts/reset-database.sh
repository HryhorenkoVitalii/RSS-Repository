#!/usr/bin/env bash
# Remove local SQLite files so sqlx can apply migrations from a clean state.
# Use when you see ChecksumMismatch / VersionMissing after schema changes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -f rss_repository.db rss_repository.db-wal rss_repository.db-shm
echo "Removed rss_repository.db (and -wal/-shm if present) in $ROOT"
