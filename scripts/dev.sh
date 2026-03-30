#!/usr/bin/env bash
# API :8080, then Vite :5173 (Ctrl+C stops child processes).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fuser -k 8080/tcp 2>/dev/null || true
fuser -k 5173/tcp 2>/dev/null || true
sleep 0.5

cleanup() {
  local p
  for p in $(jobs -p); do kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM

if [[ ! -d frontend/node_modules/vite ]]; then
  echo "frontend: run: npm install --prefix frontend" >&2
  exit 1
fi

echo "Starting API (cargo run)…"
cargo run &
API_PID=$!

HEALTH="http://127.0.0.1:8080/api/health"
for i in $(seq 1 120); do
  if curl -sf "$HEALTH" >/dev/null; then
    echo "API is up ($HEALTH)."
    break
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "cargo run exited before API became ready. Check DATABASE_URL and logs above." >&2
    exit 1
  fi
  sleep 1
done

if ! curl -sf "$HEALTH" >/dev/null; then
  echo "Timeout: API did not respond on :8080 within 120s (first compile can be slow — run again or run cargo build first)." >&2
  exit 1
fi

echo "Starting Vite..."
(cd frontend && npm run dev) &
wait
