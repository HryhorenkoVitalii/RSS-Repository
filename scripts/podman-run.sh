#!/usr/bin/env bash
# Сборка образа и запуск: интерфейс и API на http://127.0.0.1:${PORT:-8080}
#
# В образе нет Vite — порта 5173 нет (он только у `npm run dev` локально).
# Открывайте сайт на 8080, не на 5173.
#
# База SQLite: на хосте создаётся HOST_DATA_DIR/RSS_DB_FILE, монтируется в контейнер как
# /data/<RSS_DB_FILE>, DATABASE_URL=sqlite:/data/<RSS_DB_FILE> — один и тот же файл.
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

# Том: каталог на хосте → /data в контейнере (тот же inode, что и файл БД на хосте).
HOST_DATA_DIR="${HOST_DATA_DIR:-$ROOT/data}"
RSS_DB_FILE="${RSS_DB_FILE:-rss_repository.db}"
mkdir -p "$HOST_DATA_DIR"
HOST_DB_PATH="${HOST_DATA_DIR}/${RSS_DB_FILE}"

if [[ ! -e "$HOST_DB_PATH" ]]; then
  touch "$HOST_DB_PATH"
fi

# В контейнере процесс под www-data (Debian: UID/GID 33). Файл и каталог должны быть доступны на запись.
CONTAINER_UID="${CONTAINER_UID:-33}"
CONTAINER_GID="${CONTAINER_GID:-33}"
set_data_owner() {
  if chown "${CONTAINER_UID}:${CONTAINER_GID}" "$HOST_DATA_DIR" "$HOST_DB_PATH" 2>/dev/null; then
    return 0
  fi
  if [[ "$(id -u)" -eq 0 ]]; then
    chown "${CONTAINER_UID}:${CONTAINER_GID}" "$HOST_DATA_DIR" "$HOST_DB_PATH" && return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo chown "${CONTAINER_UID}:${CONTAINER_GID}" "$HOST_DATA_DIR" "$HOST_DB_PATH" 2>/dev/null && return 0
  fi
  return 1
}
if ! set_data_owner; then
  echo "Предупреждение: не удалось chown ${CONTAINER_UID}:${CONTAINER_GID} на ${HOST_DATA_DIR}. При SQLite 14/8 выполни: sudo chown -R ${CONTAINER_UID}:${CONTAINER_GID} ${HOST_DATA_DIR}" >&2
fi

DATABASE_URL_CONTAINER="sqlite:/data/${RSS_DB_FILE}"

"$CMD" rm -f rss-repository 2>/dev/null || true

PORT_HOST="${PORT:-8080}"
PUBLIC="${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT_HOST}}"
VOLUME_SUFFIX="${VOLUME_SUFFIX:-}"

run_container() {
  "$CMD" run "$@" --rm \
    --name rss-repository \
    -p "${PORT_HOST}:8080" \
    -e "PUBLIC_BASE_URL=$PUBLIC" \
    -e "DATABASE_URL=${DATABASE_URL_CONTAINER}" \
    -v "${HOST_DATA_DIR}:/data${VOLUME_SUFFIX}" \
    "$IMAGE"
}

if [[ "${DETACHED:-0}" == "1" ]]; then
  run_container -d
  echo "Запущено в фоне. Откройте http://127.0.0.1:${PORT_HOST}/"
  echo "БД на хосте: ${HOST_DB_PATH} → в контейнере /data/${RSS_DB_FILE}"
  echo "(Порт 5173 — только для локального npm run dev; в контейнере используйте ${PORT_HOST}.)"
else
  run_container
fi
