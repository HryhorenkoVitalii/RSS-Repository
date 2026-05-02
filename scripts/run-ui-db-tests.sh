#!/usr/bin/env bash
# UI-уровневые интеграционные тесты с реальной MariaDB (см. tests/ui_api_database.rs).
#
# Варианты:
# 1) Поднять БД вручную / compose и передать URL:
#    RSS_TEST_DATABASE_URL='mysql://rss:pass@127.0.0.1:3306/rss_repository' ./scripts/run-ui-db-tests.sh
#
# 2) Testcontainers (образ mariadb:11) — нужен Docker или Podman с API-сокетом.
#    Для rootless Podman часто:
#    export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${RSS_TEST_DATABASE_URL:-}" ]]; then
  if [[ -z "${DOCKER_HOST:-}" ]] && [[ -S "${XDG_RUNTIME_DIR:-}/podman/podman.sock" ]]; then
    export DOCKER_HOST="unix://${XDG_RUNTIME_DIR}/podman/podman.sock"
  fi
fi

exec cargo test --test ui_api_database -- --nocapture "$@"
