use std::error::Error;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
    #[error("not found")]
    NotFound,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("bad gateway: {0}")]
    BadGateway(String),
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// Текст ошибки SQLite/sqlx: «(code: 8)» = `SQLITE_READONLY`.
fn error_text_implies_readonly(text: &str) -> bool {
    let lower = text.to_lowercase();
    if lower.contains("readonly") || lower.contains("read-only") {
        return true;
    }
    // Формат libsqlite3/sqlx: `(code: 8)` или редкие варианты
    text.contains("(code: 8)") || text.contains("code: 8)")
}

/// Обход `source()` — нужно для `MigrateError`, где код 8 внутри вложенного `sqlx::Error`.
pub fn error_chain_implies_readonly<E: Error + 'static>(e: &E) -> bool {
    let mut cur: Option<&(dyn Error + 'static)> = Some(e);
    while let Some(err) = cur {
        if error_text_implies_readonly(&err.to_string()) {
            return true;
        }
        cur = err.source();
    }
    false
}

/// Прямой `sqlx::Error::Database` с кодом 8 (в т.ч. расширенный: младший байт = 8).
fn sqlx_database_readonly(e: &sqlx::Error) -> bool {
    let Some(db) = e.as_database_error() else {
        return false;
    };
    let msg = db.message().to_lowercase();
    if msg.contains("readonly") || msg.contains("read-only") {
        return true;
    }
    if let Some(code) = db.code() {
        if let Ok(n) = code.as_ref().parse::<i32>() {
            return n & 0xFF == 8;
        }
    }
    false
}

fn sqlx_error_readonly(e: &sqlx::Error) -> bool {
    sqlx_database_readonly(e) || error_text_implies_readonly(&e.to_string())
}

fn db_client_message(e: &sqlx::Error) -> String {
    if sqlx_error_readonly(e) {
        return "Ошибка SQLite 8 (READONLY): нельзя писать в файл базы или в каталог (файлы .db-wal / .db-shm). Проверь права на каталог с БД: в Podman смонтируй том с :U (./scripts/podman-run.sh так делает по умолчанию) или выполни chown 33:33 на каталог data на хосте; при необходимости задай SQLITE_JOURNAL_MODE=delete.".to_string();
    }
    "database error".to_string()
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            AppError::BadGateway(_) => (StatusCode::BAD_GATEWAY, self.to_string()),
            AppError::Db(e) => {
                if sqlx_error_readonly(e) {
                    tracing::error!(error = %e, "database error (SQLite READONLY / code 8)");
                } else {
                    tracing::error!(error = %e, "database error");
                }
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    db_client_message(e),
                )
            }
        };
        let body = Json(ErrorBody { error: msg });
        (status, body).into_response()
    }
}
