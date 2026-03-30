#!/bin/sh
set -e
mkdir -p /data

export DATABASE_URL="${DATABASE_URL:-sqlite:/data/rss_repository.db}"
export BIND_ADDR="${BIND_ADDR:-127.0.0.1:7878}"
export RUST_LOG="${RUST_LOG:-info,rss_repository=info}"

/rss-repository &
exec nginx -g "daemon off;"
