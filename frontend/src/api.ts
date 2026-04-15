export const API_PREFIX = '/api';

/** GET/POST under `/articles/:id` returned 404 — статьи нет, это не «старый бекенд». */
export const ARTICLE_NOT_FOUND_MESSAGE = 'Статья не найдена.';

/** Backend serves OpenAPI at GET /api/openapi.json (see `src/openapi.json`). */
export const OPENAPI_SPEC_PATH = '/openapi.json';

/** Must match `FULL_PAGE_HTML_MARKER` in `src/article_expand.rs`. */
export const ARTICLE_FULL_PAGE_MARKER = '<!--rss-repository:full-page-html-->\n';

export function isFullPageArchiveBody(body: string): boolean {
  return body.startsWith(ARTICLE_FULL_PAGE_MARKER);
}

/** Legacy `article_contents` bodies: HTML wrapper + screenshot img from older Chromium saves. */
export const ARTICLE_CHROMIUM_SCREENSHOT_MARKER =
  '<!--rss-repository:chromium-screenshot-->\n';

export function isChromiumScreenshotBody(body: string): boolean {
  return body.startsWith(ARTICLE_CHROMIUM_SCREENSHOT_MARKER);
}

function getApiKey(): string | null {
  return localStorage.getItem('rss_api_key');
}

export function setApiKey(key: string | null) {
  if (key) localStorage.setItem('rss_api_key', key);
  else localStorage.removeItem('rss_api_key');
}

export function authHeaders(): Record<string, string> {
  const key = getApiKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function readJson<T>(_path: string, res: Response, text: string): Promise<T> {
  if (res.ok && text.trim() === '') {
    return undefined as T;
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Unexpected response from server`);
  }
  if (!res.ok) {
    let msg =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error: string }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText;
    msg = typeof msg === 'string' ? msg.trim() : msg;
    if (res.status === 404) {
      const articleFamily = /^\/articles\/\d+(\/|$)/.test(_path);
      const notFoundMsg =
        typeof msg === 'string' && msg.toLowerCase() === 'not found';
      if (articleFamily && notFoundMsg) {
        msg = ARTICLE_NOT_FOUND_MESSAGE;
      } else if (
        !text.trim() ||
        (typeof msg === 'string' && msg.toLowerCase() === 'not found')
      ) {
        msg =
          'Маршрут API не найден (404). Перезапустите бекенд (cargo run или npm run dev), чтобы подтянулась новая версия с «Загрузить со страницы».';
      }
    }
    throw new Error(msg);
  }
  return data as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, { headers: authHeaders() });
  const text = await res.text();
  return readJson<T>(path, res, text);
}

/** Matches `HealthResponse` from `src/routes/api/health.rs` (GET /api/health). */
export type HealthResponse = {
  ok: boolean;
  database: 'ok' | 'error';
  media_dir: 'ok' | 'missing' | 'not_a_directory';
};

export async function fetchHealth(): Promise<HealthResponse> {
  return apiGet<HealthResponse>('/health');
}

/** Raw OpenAPI 3 document (for tooling or codegen). */
export async function fetchOpenApiDocument(): Promise<unknown> {
  return apiGet<unknown>(OPENAPI_SPEC_PATH);
}

async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, { method: 'DELETE', headers: authHeaders() });
  const text = await res.text();
  return readJson<T>(path, res, text);
}

async function apiPostJson<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return readJson<T>(path, res, text);
}

export type Feed = {
  id: number;
  url: string;
  title: string | null;
  poll_interval_seconds: number;
  /** Telegram preview feeds: max posts per poll (1–500). */
  telegram_max_items: number;
  /** RSS: fetch article HTML from item link when the feed only has a short stub. */
  expand_article_from_link: boolean;
  created_at: string;
  last_polled_at: string | null;
};

export type FeedsResponse = {
  feeds: Feed[];
  total: number;
  page: number;
  limit: number;
};

function coerceFeed(raw: unknown): Feed {
  const f = raw as Record<string, unknown>;
  const tg =
    typeof f.telegram_max_items === 'number' && !Number.isNaN(f.telegram_max_items)
      ? Math.min(500, Math.max(1, Math.round(f.telegram_max_items)))
      : 500;
  const expand = Boolean(f.expand_article_from_link);
  return {
    id: Number(f.id),
    url: String(f.url ?? ''),
    title: f.title == null ? null : String(f.title),
    poll_interval_seconds: Number(f.poll_interval_seconds ?? 600),
    telegram_max_items: tg,
    expand_article_from_link: expand,
    created_at: String(f.created_at ?? ''),
    last_polled_at: f.last_polled_at == null ? null : String(f.last_polled_at),
  };
}

function normalizeFeeds(raw: unknown): FeedsResponse {
  if (Array.isArray(raw)) {
    const feeds = (raw as unknown[]).map(coerceFeed);
    return {
      feeds,
      total: feeds.length,
      page: 0,
      limit: feeds.length || 20,
    };
  }
  const o = raw as Record<string, unknown>;
  const feeds = Array.isArray(o.feeds) ? (o.feeds as unknown[]).map(coerceFeed) : [];
  return {
    feeds,
    total: typeof o.total === 'number' ? o.total : feeds.length,
    page: typeof o.page === 'number' ? o.page : 0,
    limit: typeof o.limit === 'number' ? o.limit : 20,
  };
}

export async function listFeedsPage(page: number): Promise<FeedsResponse> {
  const raw = await apiGet<unknown>(`/feeds?page=${page}`);
  return normalizeFeeds(raw);
}

/** All feeds (paginated GET until exhausted). */
export async function listAllFeeds(): Promise<Feed[]> {
  const out: Feed[] = [];
  let page = 0;
  for (;;) {
    const r = await listFeedsPage(page);
    out.push(...r.feeds);
    if (r.feeds.length === 0 || r.feeds.length < r.limit) break;
    page += 1;
  }
  return out;
}

export async function createFeed(opts: {
  url: string;
  pollIntervalSeconds: number;
  /** Set for Telegram feeds (1–500). Omitted for RSS. */
  telegramMaxItems?: number;
  /** RSS only: load full HTML from each item link when the feed body is very short. */
  expandArticleFromLink?: boolean;
}): Promise<{ id: number }> {
  const body: Record<string, unknown> = {
    url: opts.url,
    poll_interval_seconds: opts.pollIntervalSeconds,
  };
  if (opts.telegramMaxItems !== undefined) {
    body.telegram_max_items = opts.telegramMaxItems;
  }
  if (opts.expandArticleFromLink === true) {
    body.expand_article_from_link = true;
  }
  return apiPostJson('/feeds', body);
}

export async function updateFeedInterval(
  id: number,
  pollIntervalSeconds: number,
): Promise<void> {
  await apiPostJson(`/feeds/${id}/interval`, {
    poll_interval_seconds: pollIntervalSeconds,
  });
}

export async function updateFeedTelegramMaxItems(
  id: number,
  telegramMaxItems: number,
): Promise<void> {
  await apiPostJson(`/feeds/${id}/telegram-max-items`, {
    telegram_max_items: telegramMaxItems,
  });
}

export async function updateFeedExpandFromLink(
  id: number,
  expandArticleFromLink: boolean,
): Promise<void> {
  await apiPostJson(`/feeds/${id}/expand-from-link`, {
    expand_article_from_link: expandArticleFromLink,
  });
}

export async function pollFeedNow(id: number): Promise<void> {
  const res = await fetch(`${API_PREFIX}/feeds/${id}/poll`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`poll request failed: ${res.status}`);
}

export async function pollAllFeeds(): Promise<void> {
  const res = await fetch(`${API_PREFIX}/feeds/poll-all`, { method: 'POST', headers: authHeaders() });
  if (!res.ok) throw new Error(`poll-all request failed: ${res.status}`);
}

export type PollEvent = {
  feed_id: number;
  ok: boolean;
  error?: string;
};

export function subscribePollEvents(
  onEvent: (evt: PollEvent) => void,
  onError?: () => void,
): () => void {
  const key = getApiKey();
  const sseUrl = key
    ? `${API_PREFIX}/feeds/events?token=${encodeURIComponent(key)}`
    : `${API_PREFIX}/feeds/events`;
  const es = new EventSource(sseUrl);
  es.addEventListener('poll_result', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as PollEvent;
      onEvent(data);
    } catch { /* ignore malformed */ }
  });
  es.onerror = () => onError?.();
  return () => es.close();
}

export async function deleteFeed(id: number): Promise<void> {
  await apiDelete(`/feeds/${id}`);
}

export type ArticleTelegramReaction = {
  emoji: string;
  count_display: string;
};

export type Article = {
  id: number;
  feed_id: number;
  guid: string;
  title: string;
  body: string;
  published_at: string | null;
  first_seen_at: string;
  last_fetched_at: string;
  latest_content_fetched_at: string;
  content_version_count: number;
  previous_body: string | null;
  link: string | null;
  /** Present for Telegram-ingested articles with reactions. */
  telegram_reactions?: ArticleTelegramReaction[];
};

export type ArticleContentVersion = {
  id: number;
  title: string;
  body: string;
  fetched_at: string;
};

export type ArticlesResponse = {
  articles: Article[];
  total: number;
  page: number;
  limit: number;
};

function coerceTelegramReactions(raw: unknown): ArticleTelegramReaction[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ArticleTelegramReaction[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const emoji = typeof r.emoji === 'string' ? r.emoji : '';
    const count_display = typeof r.count_display === 'string' ? r.count_display : '';
    if (emoji) out.push({ emoji, count_display });
  }
  return out.length > 0 ? out : undefined;
}

function coerceArticle(raw: unknown): Article {
  const o = raw as Record<string, unknown>;
  const tg = coerceTelegramReactions(o.telegram_reactions);
  const base: Article = {
    id: Number(o.id),
    feed_id: Number(o.feed_id),
    guid: String(o.guid ?? ''),
    title: String(o.title ?? ''),
    body: String(o.body ?? ''),
    published_at: o.published_at == null ? null : String(o.published_at),
    first_seen_at: String(o.first_seen_at ?? ''),
    last_fetched_at: String(o.last_fetched_at ?? ''),
    latest_content_fetched_at: String(o.latest_content_fetched_at ?? ''),
    content_version_count: Number(o.content_version_count ?? 0),
    previous_body: o.previous_body == null ? null : String(o.previous_body),
    link: o.link == null ? null : String(o.link),
  };
  if (tg) base.telegram_reactions = tg;
  return base;
}

function normalizeArticles(raw: unknown): ArticlesResponse {
  if (Array.isArray(raw)) {
    const articles = (raw as unknown[]).map(coerceArticle);
    return {
      articles,
      total: articles.length,
      page: 0,
      limit: articles.length || 50,
    };
  }
  const o = raw as Record<string, unknown>;
  const articles = Array.isArray(o.articles)
    ? (o.articles as unknown[]).map(coerceArticle)
    : [];
  return {
    articles,
    total: typeof o.total === 'number' ? o.total : articles.length,
    page: typeof o.page === 'number' ? o.page : 0,
    limit: typeof o.limit === 'number' ? o.limit : 50,
  };
}

export type ListArticlesParams = {
  feedIds?: string[];
  modifiedOnly?: boolean;
  page?: number;
  dateFrom?: string;
  dateTo?: string;
};

export async function listArticles(
  params: ListArticlesParams,
): Promise<ArticlesResponse> {
  const q = new URLSearchParams();
  if (params.feedIds && params.feedIds.length > 0)
    q.set('feed_id', params.feedIds.join(','));
  if (params.modifiedOnly) q.set('modified_only', 'true');
  if (params.page != null && params.page > 0)
    q.set('page', String(params.page));
  if (params.dateFrom) q.set('date_from', params.dateFrom);
  if (params.dateTo) q.set('date_to', params.dateTo);
  const qs = q.toString();
  const path = qs ? `/articles?${qs}` : '/articles';
  const raw = await apiGet<unknown>(path);
  return normalizeArticles(raw);
}

export type ArticleDetailResponse = {
  article: Article;
  versions: ArticleContentVersion[];
  telegram_reactions?: ArticleTelegramReaction[];
};

export async function getArticle(id: number): Promise<ArticleDetailResponse> {
  const raw = await apiGet<unknown>(`/articles/${id}`);
  const o = raw as Record<string, unknown>;
  const article = coerceArticle(o.article ?? raw);
  const versions = Array.isArray(o.versions)
    ? (o.versions as ArticleContentVersion[])
    : [];
  const telegram_reactions = coerceTelegramReactions(o.telegram_reactions);
  return { article, versions, ...(telegram_reactions ? { telegram_reactions } : {}) };
}

export type ExpandArticleFromLinkResponse = ArticleDetailResponse & {
  unchanged: boolean;
};

export type ArticleScreenshotEntry = {
  id: number;
  captured_at: string;
  media_sha256: string;
  /** Path like `/api/media/{sha256}`. */
  media_url: string;
};

export type ArchiveFullPageResponse = ArticleDetailResponse & {
  unchanged: boolean;
  /** Present after a successful capture (including unchanged duplicate bytes). */
  screenshot?: ArticleScreenshotEntry | null;
};

function coerceScreenshotEntry(raw: unknown): ArticleScreenshotEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = Number(o.id);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    captured_at: String(o.captured_at ?? ''),
    media_sha256: String(o.media_sha256 ?? ''),
    media_url: String(o.media_url ?? ''),
  };
}

/** List Chromium PNG screenshots stored for an article (not RSS body versions). */
export async function listArticleScreenshots(
  id: number,
): Promise<ArticleScreenshotEntry[]> {
  const raw = await apiGet<unknown>(`/articles/${id}/screenshots`);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => coerceScreenshotEntry(row))
    .filter((x): x is ArticleScreenshotEntry => x != null);
}

/** Fetch article HTML from the item URL (same extractor as RSS “expand from link”) and store a new version. */
export async function expandArticleFromLinkNow(
  id: number,
): Promise<ExpandArticleFromLinkResponse> {
  const raw = await apiPostJson<unknown>(`/articles/${id}/expand-from-link`, {});
  const o = raw as Record<string, unknown>;
  const article = coerceArticle(o.article ?? raw);
  const versions = Array.isArray(o.versions)
    ? (o.versions as ArticleContentVersion[])
    : [];
  const telegram_reactions = coerceTelegramReactions(o.telegram_reactions);
  return {
    unchanged: Boolean(o.unchanged),
    article,
    versions,
    ...(telegram_reactions ? { telegram_reactions } : {}),
  };
}

/** Save a headless Chromium PNG of the article URL (`article_screenshots` + media; no new article_contents row). */
export async function archiveArticleFullPageNow(
  id: number,
): Promise<ArchiveFullPageResponse> {
  const raw = await apiPostJson<unknown>(`/articles/${id}/archive-full-page`, {});
  const o = raw as Record<string, unknown>;
  const article = coerceArticle(o.article ?? raw);
  const versions = Array.isArray(o.versions)
    ? (o.versions as ArticleContentVersion[])
    : [];
  const telegram_reactions = coerceTelegramReactions(o.telegram_reactions);
  const screenshot = coerceScreenshotEntry(o.screenshot);
  return {
    unchanged: Boolean(o.unchanged),
    article,
    versions,
    ...(screenshot ? { screenshot } : {}),
    ...(telegram_reactions ? { telegram_reactions } : {}),
  };
}

/** Blob URL for `text/html`; caller must `URL.revokeObjectURL` when done. */
export async function fetchArticleArchiveBlobUrl(
  articleId: number,
  contentId: number,
): Promise<string> {
  const res = await fetch(
    `${API_PREFIX}/articles/${articleId}/contents/${contentId}/raw-html`,
    { headers: authHeaders() },
  );
  const text = await res.text();
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = JSON.parse(text) as { error?: string };
      if (typeof j.error === 'string') msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const blob = new Blob([text], { type: 'text/html;charset=utf-8' });
  return URL.createObjectURL(blob);
}

export type ArticleTelegramReactionsPayload = {
  current: ArticleTelegramReaction[];
  history: {
    id: number;
    emoji: string;
    count_display: string;
    observed_at: string;
  }[];
};

export async function getArticleTelegramReactions(
  id: number,
): Promise<ArticleTelegramReactionsPayload> {
  return apiGet(`/articles/${id}/telegram-reactions`);
}
