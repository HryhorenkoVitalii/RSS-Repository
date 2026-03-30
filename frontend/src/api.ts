const API_PREFIX = '/api';

async function readJson<T>(path: string, res: Response, text: string): Promise<T> {
  if (res.ok && text.trim() === '') {
    return undefined as T;
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `Expected JSON from ${API_PREFIX}${path}. Is the API on :8080? Got: ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const msg =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error: string }).error === 'string'
        ? (data as { error: string }).error
        : res.statusText;
    throw new Error(msg);
  }
  return data as T;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`);
  const text = await res.text();
  return readJson<T>(path, res, text);
}

async function apiPostJson<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_PREFIX}${path}`, {
    method: 'POST',
    headers:
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
  created_at: string;
  last_polled_at: string | null;
};

export type FeedsResponse = {
  feeds: Feed[];
  total: number;
  page: number;
  limit: number;
};

function normalizeFeeds(raw: unknown): FeedsResponse {
  if (Array.isArray(raw)) {
    const feeds = raw as Feed[];
    return {
      feeds,
      total: feeds.length,
      page: 0,
      limit: feeds.length || 20,
    };
  }
  const o = raw as Record<string, unknown>;
  const feeds = Array.isArray(o.feeds) ? (o.feeds as Feed[]) : [];
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

export async function createFeed(
  url: string,
  pollIntervalSeconds: number,
): Promise<{ id: number }> {
  return apiPostJson('/feeds', { url, poll_interval_seconds: pollIntervalSeconds });
}

export async function updateFeedInterval(
  id: number,
  pollIntervalSeconds: number,
): Promise<void> {
  await apiPostJson(`/feeds/${id}/interval`, {
    poll_interval_seconds: pollIntervalSeconds,
  });
}

export async function pollFeedNow(id: number): Promise<void> {
  await apiPostJson(`/feeds/${id}/poll`);
}

export async function pollAllFeeds(): Promise<void> {
  await apiPostJson('/feeds/poll-all');
}

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

function normalizeArticles(raw: unknown): ArticlesResponse {
  if (Array.isArray(raw)) {
    const articles = raw as Article[];
    return {
      articles,
      total: articles.length,
      page: 0,
      limit: articles.length || 50,
    };
  }
  const o = raw as Record<string, unknown>;
  const articles = Array.isArray(o.articles)
    ? (o.articles as Article[])
    : [];
  return {
    articles,
    total: typeof o.total === 'number' ? o.total : articles.length,
    page: typeof o.page === 'number' ? o.page : 0,
    limit: typeof o.limit === 'number' ? o.limit : 50,
  };
}

export type ListArticlesParams = {
  feedId?: string;
  modifiedOnly?: boolean;
  page?: number;
  dateFrom?: string;
  dateTo?: string;
};

export async function listArticles(
  params: ListArticlesParams,
): Promise<ArticlesResponse> {
  const q = new URLSearchParams();
  if (params.feedId) q.set('feed_id', params.feedId);
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
};

export async function getArticle(id: number): Promise<ArticleDetailResponse> {
  return apiGet(`/articles/${id}`);
}
