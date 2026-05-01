//! Общие чтения переменных окружения (без дублирования по модулям).

pub fn env_trim(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `1` / `true` / `yes` (после trim), иначе `false` если переменная не задана.
pub fn env_truthy(key: &str) -> bool {
    std::env::var(key)
        .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
        .unwrap_or(false)
}
