#!/usr/bin/env bash
# Сборка образа и запуск: UI + API на http://127.0.0.1:8080
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
IMAGE="${IMAGE:-rss-repository}"
CMD="${PODMAN:-podman}"

"$CMD" build -t "$IMAGE" -f Containerfile .

exec "$CMD" run --rm \
  --name rss-repository \
  -p "${PORT:-8080}:8080" \
  -e "PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT:-8080}}" \
  -v "${VOLUME:-rss-repository-data}:/data" \
  "$IMAGE"
