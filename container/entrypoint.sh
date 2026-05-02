#!/bin/sh
set -e
# /data — том или слой образа; создаём подкаталоги и отдаём www-data (не root на время работы).
mkdir -p /data/media
chown -R www-data:www-data /data

if [ -z "${DATABASE_URL:-}" ]; then
  echo "entrypoint: задайте DATABASE_URL (MySQL/MariaDB), например mysql://user:pass@host:3306/dbname" >&2
  exit 1
fi
export BIND_ADDR="${BIND_ADDR:-127.0.0.1:7878}"
export RUST_LOG="${RUST_LOG:-info,rss_repository=info}"

/usr/sbin/runuser -u www-data -- /bin/sh -c '/rss-repository & exec nginx -g "daemon off;"'
