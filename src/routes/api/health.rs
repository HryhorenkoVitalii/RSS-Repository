use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::media;

use crate::routes::AppState;

#[derive(Serialize)]
pub(super) struct HealthResponse {
    /// Готовность API: только проверка SQLite (для оркестраторов).
    pub ok: bool,
    pub database: &'static str,
    /// Каталог `MEDIA_DIR` (или default): `ok` | `missing` | `not_a_directory` (не влияет на `ok`).
    pub media_dir: &'static str,
}

pub(super) async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let db_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();

    let dir = media::media_dir();
    let media_st = if tokio::fs::metadata(&dir).await.is_err() {
        "missing"
    } else if !dir.is_dir() {
        "not_a_directory"
    } else {
        "ok"
    };

    Json(HealthResponse {
        ok: db_ok,
        database: if db_ok { "ok" } else { "error" },
        media_dir: media_st,
    })
}
