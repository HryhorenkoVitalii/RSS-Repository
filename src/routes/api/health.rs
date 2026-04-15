use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub(super) struct HealthOk {
    pub ok: bool,
}

pub(super) async fn health() -> Json<HealthOk> {
    Json(HealthOk { ok: true })
}
