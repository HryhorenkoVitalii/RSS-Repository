#!/usr/bin/env bash
# Сборка и запуск через Compose: приложение + MariaDB в одном проекте и общей сети стека.
# Снаружи доступен только порт приложения (по умолчанию 8080); БД слушает только внутри сети compose.
#
# Требуется: Docker Compose v2 (`docker compose`) или Podman Compose (`podman compose`).
#
# Примеры:
#   ./scripts/podman-run.sh              # поднять в фоне с пересборкой при необходимости
#   COMPOSE_UP_FLAGS="--build" ./scripts/podman-run.sh
#   PORT=9000 ./scripts/podman-run.sh
#
# Логи:   compose logs -f app
# Стоп:   compose down   (в каталоге репозитория)
#
# Медиа хранятся в именованном томе app_media (см. compose.yaml), не в ./data на хосте.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="${COMPOSE_FILE:-$ROOT/compose.yaml}"

pick_compose() {
  if [[ -n "${COMPOSE_CMD:-}" ]]; then
    echo "$COMPOSE_CMD"
    return
  fi
  if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
    echo "podman compose"
    return
  fi
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return
  fi
  echo "Не найден «podman compose» или «docker compose». Установите Compose v2 или задайте COMPOSE_CMD." >&2
  exit 1
}

C="$(pick_compose)"
DEFAULT_UP_FLAGS="-d --build"
FLAGS="${COMPOSE_UP_FLAGS:-$DEFAULT_UP_FLAGS}"

# shellcheck disable=SC2086
$C -f "$COMPOSE_FILE" up $FLAGS

echo "Откройте ${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT:-8080}/}"
echo "MariaDB доступна только контейнеру app по имени сервиса «db» (порт 3306 не проброшен на хост)."
echo "Остановка: cd \"$ROOT\" && $C -f \"$COMPOSE_FILE\" down"
