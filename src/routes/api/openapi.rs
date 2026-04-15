use axum::Json;
use serde_json::Value;

pub(super) async fn openapi_json() -> Json<Value> {
    Json(
        serde_json::from_str(include_str!("../../openapi.json"))
            .expect("openapi.json must be valid JSON"),
    )
}
