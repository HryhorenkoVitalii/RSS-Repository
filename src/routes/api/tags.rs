use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::db;
use crate::error::AppError;

use crate::routes::AppState;

#[derive(Deserialize)]
pub(super) struct CreateTagBody {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Serialize)]
pub(super) struct CreateTagResponse {
    pub id: i64,
}

#[derive(Deserialize, Default)]
pub(super) struct PatchTagBody {
    pub name: Option<String>,
    pub color: Option<String>,
}

pub(super) async fn list_tags(
    State(state): State<AppState>,
) -> Result<Json<Vec<db::Tag>>, AppError> {
    let rows = db::list_tags(&state.pool).await?;
    Ok(Json(rows))
}

pub(super) async fn create_tag(
    State(state): State<AppState>,
    Json(body): Json<CreateTagBody>,
) -> Result<(StatusCode, Json<CreateTagResponse>), AppError> {
    let color = body.color.as_deref();
    let id = db::create_tag(state.db_write.as_ref(), &state.pool, &body.name, color).await?;
    Ok((StatusCode::CREATED, Json(CreateTagResponse { id })))
}

pub(super) async fn patch_tag(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<PatchTagBody>,
) -> Result<StatusCode, AppError> {
    let name = body.name.as_deref();
    let color = body.color.as_deref();
    db::update_tag(
        state.db_write.as_ref(),
        &state.pool,
        id,
        name,
        color,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn delete_tag(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if !db::delete_tag(state.db_write.as_ref(), &state.pool, id).await? {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}
