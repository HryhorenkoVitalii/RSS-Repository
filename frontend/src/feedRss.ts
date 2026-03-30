/** Relative URL; in dev Vite proxies `/feed.xml` to the API. */
export function feedRssPath(feedId: number): string {
  return `/feed.xml?${new URLSearchParams({ feed_id: String(feedId) })}`;
}

/** Absolute URL for copying (same host as this page). */
export function feedRssAbsoluteUrl(feedId: number): string {
  return `${window.location.origin}${feedRssPath(feedId)}`;
}
