//! Маркер для версий `article_contents`, которые отдаются как полный HTML через `raw-html` (iframe).

/// Prepended to `article_contents.body` so the UI serves this version via `raw-html` in an iframe.
pub const FULL_PAGE_HTML_MARKER: &str = "<!--rss-repository:full-page-html-->\n";
