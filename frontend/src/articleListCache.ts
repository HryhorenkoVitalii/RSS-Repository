import type { Article, ListArticlesParams } from './api';

export type CachedArticlesList = {
  articles: Article[];
  total: number;
  limit: number;
};

const MAX_ENTRIES = 24;
const store = new Map<string, CachedArticlesList>();

function cacheKey(p: ListArticlesParams): string {
  const feeds = [...(p.feedIds ?? [])].sort().join(',');
  const tags = [...(p.tagIds ?? [])].sort().join(',');
  return [
    feeds,
    tags,
    p.modifiedOnly ? '1' : '0',
    String(p.page ?? 0),
    String(p.limit ?? ''),
    p.dateFrom ?? '',
    p.dateTo ?? '',
    p.q?.trim() ?? '',
  ].join('|');
}

export function readArticlesListCache(p: ListArticlesParams): CachedArticlesList | null {
  return store.get(cacheKey(p)) ?? null;
}

export function writeArticlesListCache(p: ListArticlesParams, data: CachedArticlesList): void {
  const k = cacheKey(p);
  if (store.has(k)) {
    store.delete(k);
  } else if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest != null) store.delete(oldest);
  }
  store.set(k, data);
}
