//! Переменные окружения для скриншотов Chromium (ширина, высота, таймаут).

use crate::env_util::env_trim;

pub fn screenshot_width() -> u32 {
    env_trim("SCREENSHOT_WIDTH")
        .and_then(|s| s.parse().ok())
        .filter(|n: &u32| (*n >= 320) && (*n <= 3840))
        .unwrap_or(1400)
}

pub fn screenshot_max_height() -> u32 {
    env_trim("SCREENSHOT_MAX_HEIGHT")
        .and_then(|s| s.parse().ok())
        .filter(|n: &u32| (*n >= 600) && (*n <= 32768))
        .unwrap_or(16_000)
}

pub fn chromium_timeout_secs() -> u64 {
    env_trim("CHROMIUM_TIMEOUT_SECS")
        .and_then(|s| s.parse().ok())
        .filter(|n: &u64| (*n >= 10) && (*n <= 600))
        .unwrap_or(120)
}
