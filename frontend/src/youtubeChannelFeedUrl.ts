/** Canonical Atom URL for a YouTube channel (MRSS). */
const YOUTUBE_VIDEOS_FEED = 'https://www.youtube.com/feeds/videos.xml';

/** Typical channel id: `UC` + 22 chars (24 total). Allow a slightly wider range for forward compatibility. */
function isLikelyYoutubeChannelId(id: string): boolean {
  return /^UC[A-Za-z0-9_-]{10,32}$/.test(id);
}

function normalizeChannelIdCase(id: string): string {
  if (id.length >= 2 && id.slice(0, 2).toLowerCase() === 'uc') {
    return `UC${id.slice(2)}`;
  }
  return id;
}

function canonicalFeedUrl(channelId: string): string {
  const id = normalizeChannelIdCase(channelId.trim());
  return `${YOUTUBE_VIDEOS_FEED}?channel_id=${encodeURIComponent(id)}`;
}

/**
 * Accepts:
 * - ready-made `https://www.youtube.com/feeds/videos.xml?channel_id=UC…`
 * - channel page `https://www.youtube.com/channel/UC…`
 * - bare id `UC…`
 *
 * Does **not** resolve `@handle` or `/c/Name` (needs YouTube Data API).
 */
export function normalizeYouTubeChannelFeedUrl(raw: string): string | null {
  const s0 = raw.trim();
  if (!s0) return null;

  const withScheme = /^https?:\/\//i.test(s0) ? s0 : `https://${s0}`;

  try {
    const u = new URL(withScheme);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtube.com') {
      const path = u.pathname.replace(/\/+$/, '') || '/';
      if (path.endsWith('/feeds/videos.xml')) {
        const id = u.searchParams.get('channel_id')?.trim() ?? '';
        if (isLikelyYoutubeChannelId(id)) return canonicalFeedUrl(id);
        return null;
      }
      const m = path.match(/^\/channel\/([^/]+)/i);
      if (m) {
        const id = decodeURIComponent(m[1]).trim();
        if (isLikelyYoutubeChannelId(id)) return canonicalFeedUrl(id);
        return null;
      }
    }
  } catch {
    /* bare id below */
  }

  const bare = s0.replace(/^https?:\/\//i, '').trim();
  if (isLikelyYoutubeChannelId(bare)) return canonicalFeedUrl(bare);

  return null;
}

/** True if stored feed URL is the official YouTube channel Atom feed. */
export function isYoutubeChannelFeedUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    return (
      host === 'youtube.com' &&
      u.pathname.replace(/\/+$/, '').endsWith('/feeds/videos.xml') &&
      Boolean(u.searchParams.get('channel_id')?.trim())
    );
  } catch {
    return false;
  }
}
