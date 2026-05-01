export type RssExportParams = {
  feedIds?: number[];
  /** Feeds that have any of these tag ids (OR). */
  tagIds?: number[];
  modifiedOnly?: boolean;
  dateFrom?: string;
  dateTo?: string;
};

export function feedRssPath(params: RssExportParams): string {
  const q = new URLSearchParams();
  if (params.feedIds && params.feedIds.length > 0) {
    q.set('feed_id', params.feedIds.join(','));
  }
  if (params.tagIds && params.tagIds.length > 0) {
    q.set('tag_id', params.tagIds.join(','));
  }
  if (params.modifiedOnly) q.set('modified_only', 'true');
  if (params.dateFrom) q.set('date_from', params.dateFrom);
  if (params.dateTo) q.set('date_to', params.dateTo);
  q.set('refresh', 'false');
  const qs = q.toString();
  return qs ? `/feed.xml?${qs}` : '/feed.xml';
}

export function feedRssAbsoluteUrl(params: RssExportParams): string {
  return `${window.location.origin}${feedRssPath(params)}`;
}

/** Legacy single-feed shortcut used by FeedsPage. */
export function singleFeedRssPath(feedId: number): string {
  return feedRssPath({ feedIds: [feedId] });
}

export function singleFeedRssAbsoluteUrl(feedId: number): string {
  return `${window.location.origin}${singleFeedRssPath(feedId)}`;
}

/** Stored feed URL is canonical Telegram preview (`/s/`). */
export function isTelegramFeedUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    const h = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (h !== 't.me' && h !== 'telegram.me') return false;
    return u.pathname.startsWith('/s/');
  } catch {
    return false;
  }
}
