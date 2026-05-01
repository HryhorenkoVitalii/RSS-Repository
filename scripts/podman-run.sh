#!/usr/bin/env bash
# Сборка образа и запуск: интерфейс и API на http://127.0.0.1:${PORT:-8080}
#
# В образе нет Vite — порта 5173 нет (он только у `npm run dev` локально).
# Открывайте сайт на 8080, не на 5173.
#
# Фон: DETACHED=1 ./scripts/podman-run.sh
# SELinux (Podman): VOLUME_SUFFIX=:U ./scripts/podman-run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
IMAGE="${IMAGE:-rss-repository}"
CMD="${PODMAN:-podman}"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  "$CMD" build -t "$IMAGE" -f Containerfile .
fi

HOST_DATA_DIR="${HOST_DATA_DIR:-$ROOT/data}"
mkdir -p "$HOST_DATA_DIR"

"$CMD" rm -f rss-repository 2>/dev/null || true

PORT_HOST="${PORT:-8080}"
PUBLIC="${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT_HOST}}"
VOLUME_SUFFIX="${VOLUME_SUFFIX:-}"

run_container() {
  "$CMD" run "$@" --rm \
    --name rss-repository \
    -p "${PORT_HOST}:8080" \
    -e "PUBLIC_BASE_URL=$PUBLIC" \
    -v "${HOST_DATA_DIR}:/data${VOLUME_SUFFIX}" \
    "$IMAGE"
}

if [[ "${DETACHED:-0}" == "1" ]]; then
  run_container -d
  echo "Запущено в фоне. Откройте http://127.0.0.1:${PORT_HOST}/"
  echo "(Порт 5173 — только для локального npm run dev; в контейнере используйте ${PORT_HOST}.)"
else
  run_container
fi
