use sqlx::MySqlPool;
use tokio::sync::Semaphore;

pub async fn insert_request_log(
    write_lock: &Semaphore,
    pool: &MySqlPool,
    method: &str,
    path: &str,
    status_code: i64,
    duration_ms: i64,
) -> Result<(), sqlx::Error> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    sqlx::query(
        r#"INSERT INTO request_log (method, path, status_code, duration_ms) VALUES (?, ?, ?, ?)"#,
    )
    .bind(method)
    .bind(path)
    .bind(status_code)
    .bind(duration_ms)
    .execute(pool)
    .await?;
    Ok(())
}
