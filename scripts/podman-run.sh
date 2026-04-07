#!/usr/bin/env bash
# Сборка образа и запуск: UI + API на http://127.0.0.1:8080
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
IMAGE="${IMAGE:-rss-repository}"
CMD="${PODMAN:-podman}"

"$CMD" build -t "$IMAGE" -f Containerfile .

# Каталог на хосте → /data в контейнере (SQLite переживает удаление/пересборку образа).
# Переопределение: HOST_DATA_DIR=/home/you/rss-db ./scripts/podman-run.sh
HOST_DATA_DIR="${HOST_DATA_DIR:-$ROOT/data}"
mkdir -p "$HOST_DATA_DIR"

exec "$CMD" run --rm \
  --name rss-repository \
  -p "${PORT:-8080}:8080" \
  -e "PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT:-8080}}" \
  -v "$HOST_DATA_DIR:/data" \
  "$IMAGE"
