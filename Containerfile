# podman build -t rss-repository .
# podman run --rm -p 8080:8080 -v rss-repo-data:/data rss-repository

FROM node:22-bookworm-slim AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
COPY frontend ./frontend
RUN cd frontend && npm run build

FROM rust:1-bookworm AS rust
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY migrations ./migrations
RUN cargo build --locked --release

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/nginx/body /var/log/nginx /data \
  && chown -R www-data:www-data /var/lib/nginx /var/log/nginx /usr/share/nginx/html

COPY --from=frontend /app/frontend/dist /usr/share/nginx/html
COPY --from=rust /app/target/release/rss-repository /rss-repository
COPY container/nginx.conf /etc/nginx/nginx.conf
COPY container/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /rss-repository

ENV DATABASE_URL=sqlite:/data/rss_repository.db
ENV BIND_ADDR=127.0.0.1:7878
ENV RUST_LOG=info,rss_repository=info

EXPOSE 8080
VOLUME /data

ENTRYPOINT ["/entrypoint.sh"]
