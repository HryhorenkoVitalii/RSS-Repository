#!/bin/sh
set -e
# /data обычно примонтирован с хоста (rootless Podman): chown может быть запрещён.
# Поэтому создаём каталоги и пробуем сменить владельца "мягко" — без падения контейнера.
mkdir -p /data/media

if command -v chown >/dev/null 2>&1; then
  if ! chown -R 33:33 /data 2>/dev/null; then
    echo "entrypoint: WARN: cannot chown /data (likely rootless bind mount); continuing" >&2
  fi
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "entrypoint: задайте DATABASE_URL (MySQL/MariaDB), например mysql://user:pass@host:3306/dbname" >&2
  exit 1
fi
export BIND_ADDR="${BIND_ADDR:-127.0.0.1:7878}"
export RUST_LOG="${RUST_LOG:-info,rss_repository=info}"

/usr/sbin/runuser -u www-data -- /bin/sh -c '/rss-repository & exec nginx -g "daemon off;"'
