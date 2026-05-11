const STORAGE_KEY = 'rss_repo_articles_list_v1';

export type ArticleViewModePref = 'list' | 'tiles' | 'feed';

export type ArticleListPrefs = {
  feedIds: string[];
  tagIds: string[];
  modifiedOnly: boolean;
  dateFrom: string;
  dateTo: string;
  view: ArticleViewModePref;
};

const defaultPrefs = (): ArticleListPrefs => ({
  feedIds: [],
  tagIds: [],
  modifiedOnly: false,
  dateFrom: '',
  dateTo: '',
  view: 'list',
});

export function loadArticleListPrefs(): ArticleListPrefs | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<ArticleListPrefs>;
    if (!o || typeof o !== 'object') return null;
    const d = defaultPrefs();
    return {
      feedIds: Array.isArray(o.feedIds) ? o.feedIds.filter((x) => typeof x === 'string') : d.feedIds,
      tagIds: Array.isArray(o.tagIds) ? o.tagIds.filter((x) => typeof x === 'string') : d.tagIds,
      modifiedOnly: typeof o.modifiedOnly === 'boolean' ? o.modifiedOnly : d.modifiedOnly,
      dateFrom: typeof o.dateFrom === 'string' ? o.dateFrom : d.dateFrom,
      dateTo: typeof o.dateTo === 'string' ? o.dateTo : d.dateTo,
      view:
        o.view === 'tiles' ? 'tiles' : o.view === 'feed' ? 'feed' : 'list',
    };
  } catch {
    return null;
  }
}

export function saveArticleListPrefs(p: ArticleListPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota */
  }
}

export function clearArticleListPrefs(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
