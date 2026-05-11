import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { sanitizeArticleBodyHtml } from '../articleHtmlSanitize';
import { formatArticlesListForAi } from '../aiScreenDigest';
import { useAiScreenSection } from '../aiScreenContext';
import {
  DEFAULT_TAG_COLOR,
  isFullPageArchiveBody,
  listAllFeeds,
  listArticles,
  listTags,
  type Article,
  type Feed,
  type Tag,
} from '../api';
import { TelegramReactionsStrip } from '../TelegramReactionsStrip';
import { formatDateTime } from '../formatTime';
import { PaginationBar } from '../PaginationBar';
import { readArticlesListCache, writeArticlesListCache } from '../articleListCache';
import {
  clearArticleListPrefs,
  loadArticleListPrefs,
  saveArticleListPrefs,
  type ArticleViewModePref,
} from '../articleListPrefs';
import { pickTagChipTextColor } from '../tagChipText';
import {
  hasArticleListFilterParamsInSearch,
  OPEN_ARTICLES_FILTERS_EVENT,
} from '../articlesFilterUi';

function parseCommaSepIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

type ArticleViewMode = ArticleViewModePref;

const FEED_SCROLL_BATCH = 5;
const FEED_SCROLL_TRIM_PREVIOUS = 4;

function parseViewMode(raw: string | null): ArticleViewMode {
  if (raw === 'tiles') return 'tiles';
  if (raw === 'feed') return 'feed';
  return 'list';
}

/** Stable empty array so memoized rows/tiles do not re-render when a feed has no tags. */
const EMPTY_FEED_TAGS: Tag[] = [];

/** First usable image URL from stored article HTML (img src or video poster). */
function firstImageUrlFromArticle(html: string): string | null {
  // Полностраничный PNG — слишком высокий для превью; cover обрезает «не туда» и часто даёт чёрные полосы.
  if (!html || isFullPageArchiveBody(html)) return null;
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const u = m[1].trim().replace(/&amp;/g, '&');
    if (u.startsWith('data:')) continue;
    if (
      u.startsWith('http://') ||
      u.startsWith('https://') ||
      u.startsWith('/')
    ) {
      return u;
    }
  }
  const poster = /<video\b[^>]*\bposter\s*=\s*["']([^"']+)["']/i.exec(html);
  if (poster) {
    const u = poster[1].trim().replace(/&amp;/g, '&');
    if (
      u.startsWith('http://') ||
      u.startsWith('https://') ||
      u.startsWith('/')
    ) {
      return u;
    }
  }
  return null;
}

export function ArticlesPage() {
  const [search, setSearch] = useSearchParams();
  const [prefsReady, setPrefsReady] = useState(false);
  /** Merge saved list prefs into the URL only once; repeating this effect would fight user clicks (stale LS vs new URL). */
  const articleListPrefsHydratedRef = useRef(false);

  useLayoutEffect(() => {
    if (articleListPrefsHydratedRef.current) return;
    articleListPrefsHydratedRef.current = true;

    const sp = new URLSearchParams(window.location.search);
    const hasFilters = hasArticleListFilterParamsInSearch(sp);
    const saved = loadArticleListPrefs();

    if (!saved) {
      setPrefsReady(true);
      return;
    }

    const needsFilterMerge =
      !hasFilters &&
      (saved.feedIds.length > 0 ||
        saved.tagIds.length > 0 ||
        saved.modifiedOnly ||
        Boolean(saved.dateFrom) ||
        Boolean(saved.dateTo));

    const urlViewRaw = sp.get('view');
    /** Не затирать явный `view` в URL; без параметра — подставить сохранённый режим (tiles/feed). */
    const needsViewMerge =
      urlViewRaw == null || urlViewRaw === ''
        ? saved.view !== 'list'
        : saved.view === 'tiles'
          ? urlViewRaw !== 'tiles'
          : saved.view === 'feed'
            ? urlViewRaw !== 'feed'
            : urlViewRaw === 'tiles' || urlViewRaw === 'feed';

    const needMerge = needsFilterMerge || needsViewMerge;

    if (!needMerge) {
      setPrefsReady(true);
      return;
    }

    setSearch(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (!hasFilters && needsFilterMerge) {
          if (saved.feedIds.length > 0) p.set('feed_id', saved.feedIds.join(','));
          else p.delete('feed_id');
          if (saved.tagIds.length > 0) p.set('tag_id', saved.tagIds.join(','));
          else p.delete('tag_id');
          if (saved.modifiedOnly) p.set('modified_only', 'true');
          else p.delete('modified_only');
          if (saved.dateFrom) p.set('date_from', saved.dateFrom);
          else p.delete('date_from');
          if (saved.dateTo) p.set('date_to', saved.dateTo);
          else p.delete('date_to');
        }
        if (saved.view === 'tiles') p.set('view', 'tiles');
        else if (saved.view === 'feed') p.set('view', 'feed');
        else p.delete('view');
        if (needsFilterMerge) p.delete('page');
        return p;
      },
      { replace: true },
    );
    setPrefsReady(true);
  }, [setSearch]);

  const feedIds = parseCommaSepIds(search.get('feed_id'));
  const tagIds = parseCommaSepIds(search.get('tag_id'));
  const modifiedOnly = search.get('modified_only') === 'true';
  const page = Math.max(0, Number(search.get('page') ?? '0') || 0);
  const dateFrom = search.get('date_from') ?? '';
  const dateTo = search.get('date_to') ?? '';
  const searchQ = search.get('q') ?? '';
  const viewMode = parseViewMode(search.get('view'));

  const articleFilterParamsBase = useMemo(
    () => ({
      feedIds: feedIds.length > 0 ? feedIds : undefined,
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      modifiedOnly,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      q: searchQ.trim() || undefined,
    }),
    [feedIds.join(','), tagIds.join(','), modifiedOnly, dateFrom, dateTo, searchQ],
  );

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const articlesLoadGenRef = useRef(0);

  type FeedPackState = {
    items: Article[];
    total: number;
    nextFetchPage: number;
    hasMore: boolean;
    loading: boolean;
    loadingMore: boolean;
    err: string | null;
  };

  const [feedPack, setFeedPack] = useState<FeedPackState | null>(null);
  const feedPackRef = useRef<FeedPackState | null>(null);
  const articleFilterParamsRef = useRef(articleFilterParamsBase);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  const feedMoreLock = useRef(false);

  useEffect(() => {
    feedPackRef.current = feedPack;
  }, [feedPack]);

  useEffect(() => {
    articleFilterParamsRef.current = articleFilterParamsBase;
  }, [articleFilterParamsBase]);

  useEffect(() => {
    void listAllFeeds()
      .then(setFeeds)
      .catch(() => setFeeds([]));
  }, []);

  useEffect(() => {
    void listTags()
      .then(setAllTags)
      .catch(() => setAllTags([]));
  }, []);

  const load = useCallback(async () => {
    if (viewMode === 'feed') return;
    const gen = ++articlesLoadGenRef.current;
    const params = { ...articleFilterParamsBase, page };

    const cached = readArticlesListCache(params);
    if (cached) {
      setArticles(cached.articles);
      setTotal(cached.total);
      setLimit(cached.limit);
      setErr(null);
      setLoading(false);
    } else {
      setLoading(true);
      setErr(null);
    }

    try {
      const r = await listArticles(params);
      if (gen !== articlesLoadGenRef.current) return;
      writeArticlesListCache(params, {
        articles: r.articles,
        total: r.total,
        limit: r.limit,
      });
      setArticles(r.articles);
      setTotal(r.total);
      setLimit(r.limit);
      setErr(null);
    } catch (e) {
      if (gen !== articlesLoadGenRef.current) return;
      if (!cached) {
        setErr(e instanceof Error ? e.message : String(e));
        setArticles([]);
        setTotal(0);
      }
    } finally {
      if (gen === articlesLoadGenRef.current) {
        setLoading(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleFilterParamsBase, page, viewMode]);

  useEffect(() => {
    if (!prefsReady) return;
    if (viewMode === 'feed') return;
    void load();
  }, [load, prefsReady, viewMode]);

  useEffect(() => {
    if (viewMode === 'feed') return;
    setFeedPack(null);
  }, [viewMode]);

  useEffect(() => {
    if (!prefsReady || viewMode !== 'feed') return;
    let cancelled = false;
    setFeedPack({
      items: [],
      total: 0,
      nextFetchPage: 0,
      hasMore: false,
      loading: true,
      loadingMore: false,
      err: null,
    });
    void listArticles({
      ...articleFilterParamsBase,
      page: 0,
      limit: FEED_SCROLL_BATCH,
    })
      .then((r) => {
        if (cancelled) return;
        setFeedPack({
          items: r.articles,
          total: r.total,
          nextFetchPage: 1,
          hasMore:
            r.articles.length === FEED_SCROLL_BATCH && r.total > r.articles.length,
          loading: false,
          loadingMore: false,
          err: null,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setFeedPack({
          items: [],
          total: 0,
          nextFetchPage: 0,
          hasMore: false,
          loading: false,
          loadingMore: false,
          err: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [prefsReady, viewMode, articleFilterParamsBase]);

  const fetchNextFeedBatch = useCallback(async () => {
    if (feedMoreLock.current) return;
    const snap = feedPackRef.current;
    if (!snap || snap.loading || snap.loadingMore || !snap.hasMore) return;
    feedMoreLock.current = true;
    setFeedPack((p) => (p ? { ...p, loadingMore: true } : p));
    try {
      const r = await listArticles({
        ...articleFilterParamsRef.current,
        page: snap.nextFetchPage,
        limit: FEED_SCROLL_BATCH,
      });
      if (r.articles.length === 0) {
        setFeedPack((p) => (p ? { ...p, loadingMore: false, hasMore: false } : p));
        return;
      }
      setFeedPack((p) => {
        if (!p) return p;
        const nextItems = [...p.items.slice(FEED_SCROLL_TRIM_PREVIOUS), ...r.articles];
        const nextFetchPage = p.nextFetchPage + 1;
        return {
          ...p,
          items: nextItems,
          nextFetchPage,
          loadingMore: false,
          hasMore:
            r.articles.length === FEED_SCROLL_BATCH &&
            nextFetchPage * FEED_SCROLL_BATCH < p.total,
          err: null,
        };
      });
    } catch (e) {
      setFeedPack((p) =>
        p
          ? {
              ...p,
              loadingMore: false,
              err: e instanceof Error ? e.message : String(e),
            }
          : p,
      );
    } finally {
      feedMoreLock.current = false;
    }
  }, []);

  useEffect(() => {
    if (viewMode !== 'feed') return;
    const el = feedSentinelRef.current;
    const snap = feedPack;
    if (!el || !snap || !snap.hasMore || snap.loading) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.some((e) => e.isIntersecting);
        if (!hit) return;
        const s = feedPackRef.current;
        if (!s || s.loadingMore || s.loading || !s.hasMore) return;
        void fetchNextFeedBatch();
      },
      { root: null, rootMargin: '280px', threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [
    viewMode,
    fetchNextFeedBatch,
    feedPack?.hasMore,
    feedPack?.loading,
    feedPack?.items.length,
    feedPack?.loadingMore,
  ]);

  useEffect(() => {
    if (!prefsReady) return;
    saveArticleListPrefs({
      feedIds,
      tagIds,
      modifiedOnly,
      dateFrom,
      dateTo,
      view: viewMode,
    });
    // feedIds/tagIds are new [] each render; join keeps the effect stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsReady, feedIds.join(','), tagIds.join(','), modifiedOnly, dateFrom, dateTo, viewMode]);

  function setParam(key: string, value: string | null) {
    setSearch(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (value == null || value === '') p.delete(key);
        else p.set(key, value);
        return p;
      },
      { replace: true },
    );
  }

  const formRef = useRef<HTMLFormElement>(null);

  const [pendingFeedIds, setPendingFeedIds] = useState<string[]>(feedIds);
  useEffect(() => {
    setPendingFeedIds(feedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedIds.join(',')]);

  const [pendingTagIds, setPendingTagIds] = useState<string[]>(tagIds);
  useEffect(() => {
    setPendingTagIds(tagIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagIds.join(',')]);

  const [pendingSearch, setPendingSearch] = useState(searchQ);
  useEffect(() => {
    setPendingSearch(searchQ);
  }, [searchQ]);

  const [feedSearch, setFeedSearch] = useState('');
  const [tagSearch, setTagSearch] = useState('');

  function toggleFeed(id: string) {
    setPendingFeedIds((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id],
    );
  }

  function toggleTag(id: string) {
    setPendingTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }

  function onApplyFilters(e: React.FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    setSearch(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (pendingFeedIds.length > 0) p.set('feed_id', pendingFeedIds.join(','));
        else p.delete('feed_id');
        if (pendingTagIds.length > 0) p.set('tag_id', pendingTagIds.join(','));
        else p.delete('tag_id');
        if (fd.get('modified_only')) p.set('modified_only', 'true');
        else p.delete('modified_only');
        const df = (fd.get('date_from') as string) ?? '';
        const dt = (fd.get('date_to') as string) ?? '';
        if (df) p.set('date_from', df);
        else p.delete('date_from');
        if (dt) p.set('date_to', dt);
        else p.delete('date_to');
        const rawQ = pendingSearch.trim();
        if (rawQ) p.set('q', rawQ);
        else p.delete('q');
        p.delete('page');
        return p;
      },
      { replace: true },
    );
  }

  function onClearAllFilters() {
    clearArticleListPrefs();
    setPendingFeedIds([]);
    setPendingTagIds([]);
    setPendingSearch('');
    setFiltersOpen(false);
    setSearch(new URLSearchParams(), { replace: true });
  }

  const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;

  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersDrawerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function onOpen() {
      setFiltersOpen(true);
    }
    window.addEventListener(OPEN_ARTICLES_FILTERS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ARTICLES_FILTERS_EVENT, onOpen);
  }, []);

  const feedMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of feeds) m.set(f.id, f.title?.trim() || f.url);
    return m;
  }, [feeds]);

  useEffect(() => {
    if (!filtersOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setFiltersOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filtersOpen]);

  /** Закрытие по клику снаружи панели (без затемнения экрана) */
  useEffect(() => {
    if (!filtersOpen) return;
    function onPointerDown(e: PointerEvent) {
      const el = filtersDrawerRef.current;
      if (!el || el.contains(e.target as Node)) return;
      setFiltersOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [filtersOpen]);

  const sortedTags = useMemo(
    () => [...allTags].sort((a, b) => a.name.localeCompare(b.name)),
    [allTags],
  );

  const filteredFeeds = useMemo(() => {
    const q = feedSearch.trim().toLowerCase();
    if (!q) return feeds;
    return feeds.filter((f) => {
      const title = (f.title ?? '').toLowerCase();
      const url = f.url.toLowerCase();
      return title.includes(q) || url.includes(q);
    });
  }, [feeds, feedSearch]);

  const filteredTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return sortedTags;
    return sortedTags.filter((t) => t.name.toLowerCase().includes(q));
  }, [sortedTags, tagSearch]);

  const feedTagsByFeedId = useMemo(() => {
    const m = new Map<number, Tag[]>();
    for (const f of feeds) {
      const raw = f.tags ?? [];
      const tags =
        raw.length === 0
          ? EMPTY_FEED_TAGS
          : raw.slice().sort((a, b) => a.name.localeCompare(b.name));
      m.set(f.id, tags);
    }
    return m;
  }, [feeds]);

  const activeFilterHint = useMemo(() => {
    const bits: string[] = [];
    if (feedIds.length > 0) {
      bits.push(feedIds.length === 1 ? '1 feed' : `${feedIds.length} feeds`);
    }
    if (tagIds.length > 0) {
      bits.push(tagIds.length === 1 ? '1 tag' : `${tagIds.length} tags`);
    }
    if (modifiedOnly) bits.push('modified');
    if (dateFrom) bits.push(`from ${dateFrom}`);
    if (dateTo) bits.push(`to ${dateTo}`);
    const qTrim = searchQ.trim();
    if (qTrim) bits.push(`search: ${qTrim.length > 40 ? `${qTrim.slice(0, 40)}…` : qTrim}`);
    return bits.length > 0 ? bits.join(' · ') : 'No extra filters';
  }, [feedIds, tagIds, modifiedOnly, dateFrom, dateTo, searchQ]);

  const articlesScreenDigest = useMemo(() => {
    if (viewMode === 'feed') {
      if (feedPack?.loading) return null;
    } else if (loading) {
      return null;
    }
    const list = viewMode === 'feed' ? (feedPack?.items ?? []) : articles;
    const tot = viewMode === 'feed' ? (feedPack?.total ?? 0) : total;
    return formatArticlesListForAi({
      articles: list,
      feedTitle: (fid) => feedMap.get(fid),
      filterSummary: `Фильтры: ${activeFilterHint}${
        viewMode === 'feed' ? ' · режим ленты (полный текст, скользящее окно)' : ''
      }`,
      page: viewMode === 'feed' ? 0 : page,
      limit: viewMode === 'feed' ? FEED_SCROLL_BATCH : limit,
      total: tot,
    });
  }, [loading, viewMode, feedPack, articles, feedMap, activeFilterHint, page, limit, total]);

  useAiScreenSection('articles', articlesScreenDigest);

  return (
    <>
      {err ? <p className="err">{err}</p> : null}

      <button
        type="button"
        className={`articles-filters-rail${filtersOpen ? ' articles-filters-rail--hidden' : ''}`}
        aria-expanded={filtersOpen}
        aria-haspopup="dialog"
        title={activeFilterHint}
        onClick={() => setFiltersOpen(true)}
      >
        <span className="articles-filters-rail-icon" aria-hidden>
          ☰
        </span>
        <span className="articles-filters-rail-label">Filters</span>
      </button>

      {filtersOpen ? (
        <>
          <aside
            id="articles-filters-drawer"
            ref={filtersDrawerRef}
            className="articles-filters-drawer"
            role="dialog"
            aria-modal="false"
            aria-labelledby="articles-filters-title"
          >
            <div className="articles-filters-drawer-scroll">
              <div className="card articles-filters-card">
                <div className="articles-filters-drawer-head">
                  <h2 id="articles-filters-title" className="card-title">
                    Filters
                  </h2>
                  <button
                    type="button"
                    className="articles-filters-close"
                    onClick={() => setFiltersOpen(false)}
                    aria-label="Close filters"
                  >
                    ×
                  </button>
                </div>
                <form
                  className="filters filters-panel-form"
                  onSubmit={onApplyFilters}
                  ref={formRef}
                  key={`${feedIds.join(',')}-${tagIds.join(',')}-${modifiedOnly}-${dateFrom}-${dateTo}-${searchQ}`}
                >
                  <section className="filters-panel-section" aria-labelledby="filters-feeds-heading">
                    <div className="filters-panel-head">
                      <div>
                        <h3 id="filters-feeds-heading" className="filters-panel-label">
                          Feeds
                        </h3>
                        <p className="filters-panel-hint muted small">
                          {pendingFeedIds.length === 0
                            ? 'Showing all feeds'
                            : `${pendingFeedIds.length} selected · OR within feeds`}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn-ghost btn-compact"
                        disabled={pendingFeedIds.length === 0}
                        onClick={() => setPendingFeedIds([])}
                      >
                        Clear
                      </button>
                    </div>
                    <input
                      type="search"
                      className="filters-panel-search"
                      placeholder="Search by title or URL…"
                      value={feedSearch}
                      onChange={(e) => setFeedSearch(e.target.value)}
                      aria-label="Search feeds"
                      autoComplete="off"
                    />
                    <div
                      className="filters-panel-scroll"
                      role="group"
                      aria-label="Feed list"
                    >
                      {feeds.length === 0 ? (
                        <p className="filters-panel-empty muted small">No feeds yet.</p>
                      ) : filteredFeeds.length === 0 ? (
                        <p className="filters-panel-empty muted small">No feeds match search.</p>
                      ) : (
                        filteredFeeds.map((f) => {
                          const title = f.title?.trim() || '';
                          const primary = title || f.url;
                          const showUrl = Boolean(title && title !== f.url);
                          return (
                            <label key={f.id} className="filters-panel-option">
                              <input
                                type="checkbox"
                                checked={pendingFeedIds.includes(String(f.id))}
                                onChange={() => toggleFeed(String(f.id))}
                              />
                              <span className="filters-panel-option-text">
                                <span className="filters-panel-option-primary">{primary}</span>
                                {showUrl ? (
                                  <span className="filters-panel-option-secondary muted">
                                    {f.url}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </section>

                  <section className="filters-panel-section" aria-labelledby="filters-tags-heading">
                    <div className="filters-panel-head">
                      <div>
                        <h3 id="filters-tags-heading" className="filters-panel-label">
                          Tags
                        </h3>
                        <p className="filters-panel-hint muted small">
                          {pendingTagIds.length === 0
                            ? 'Any tag (not filtering by tag)'
                            : `${pendingTagIds.length} selected · OR match`}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="btn-ghost btn-compact"
                        disabled={pendingTagIds.length === 0}
                        onClick={() => setPendingTagIds([])}
                      >
                        Clear
                      </button>
                    </div>
                    <input
                      type="search"
                      className="filters-panel-search"
                      placeholder="Search tags…"
                      value={tagSearch}
                      onChange={(e) => setTagSearch(e.target.value)}
                      aria-label="Search tags"
                      autoComplete="off"
                    />
                    <div
                      className="filters-panel-scroll"
                      role="group"
                      aria-label="Tag list"
                    >
                      {allTags.length === 0 ? (
                        <p className="filters-panel-empty muted small">
                          No tags yet — create them under Feeds → Tags.
                        </p>
                      ) : filteredTags.length === 0 ? (
                        <p className="filters-panel-empty muted small">No tags match search.</p>
                      ) : (
                        filteredTags.map((t) => (
                          <label
                            key={t.id}
                            className="filters-panel-option filters-panel-option--tag"
                          >
                            <input
                              type="checkbox"
                              checked={pendingTagIds.includes(String(t.id))}
                              onChange={() => toggleTag(String(t.id))}
                            />
                            <span
                              className="tag-color-dot"
                              style={{ backgroundColor: t.color }}
                              aria-hidden
                            />
                            <span className="filters-panel-option-primary">{t.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </section>

                  <section className="filters-panel-section filters-panel-section--compact">
                    <input
                      type="search"
                      className="filters-panel-search"
                      placeholder='Подстроки через пробел или запятую; фраза в "двойных кавычках"…'
                      value={pendingSearch}
                      onChange={(e) => setPendingSearch(e.target.value)}
                      aria-label="Поиск по заголовку и тексту статьи"
                      autoComplete="off"
                    />
                  </section>

                  <section className="filters-panel-section filters-panel-section--compact">
                    <h3 className="filters-panel-label">Date &amp; updates</h3>
                    <div className="filters-panel-dates">
                      <label className="filters-panel-date-field">
                        <span className="filters-panel-date-label">From</span>
                        <input type="date" name="date_from" defaultValue={dateFrom} />
                      </label>
                      <label className="filters-panel-date-field">
                        <span className="filters-panel-date-label">To</span>
                        <input type="date" name="date_to" defaultValue={dateTo} />
                      </label>
                    </div>
                    <label className="filters-panel-checkbox">
                      <input
                        type="checkbox"
                        name="modified_only"
                        value="true"
                        defaultChecked={modifiedOnly}
                      />
                      <span>Modified only</span>
                    </label>
                  </section>

                  <div className="filters-panel-actions filters-panel-actions--split">
                    <button type="submit" className="btn-primary filters-panel-apply">
                      Apply filters
                    </button>
                    <button
                      type="button"
                      className="btn-secondary filters-panel-clear"
                      onClick={onClearAllFilters}
                      title="Сбросить все фильтры и сохранённое состояние списка"
                    >
                      Сбросить
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </aside>
        </>
      ) : null}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Articles</h2>
          <div className="article-list-toolbar">
            {(() => {
              const feedLoading = viewMode === 'feed' && (!feedPack || feedPack.loading);
              const listLoading = viewMode !== 'feed' && loading;
              if (feedLoading || listLoading) return null;
              return (
                <span className="muted small">
                  {viewMode === 'feed' && feedPack
                    ? `${feedPack.total} total · в окне ${feedPack.items.length}`
                    : `${total} total`}
                </span>
              );
            })()}
            <div className="article-view-toggle" role="group" aria-label="Article layout">
              <button
                type="button"
                className={viewMode === 'list' ? 'is-active' : ''}
                onClick={() => setParam('view', null)}
                aria-pressed={viewMode === 'list'}
              >
                List
              </button>
              <button
                type="button"
                className={viewMode === 'tiles' ? 'is-active' : ''}
                onClick={() => setParam('view', 'tiles')}
                aria-pressed={viewMode === 'tiles'}
              >
                Tiles
              </button>
              <button
                type="button"
                className={viewMode === 'feed' ? 'is-active' : ''}
                onClick={() =>
                  setSearch(
                    (prev) => {
                      const p = new URLSearchParams(prev);
                      p.set('view', 'feed');
                      p.delete('page');
                      return p;
                    },
                    { replace: true },
                  )
                }
                aria-pressed={viewMode === 'feed'}
                title="Полный текст подряд; по 5 записей, при прокрутке подгружаются следующие 5, из памяти убираются предыдущие 4"
              >
                Feed
              </button>
            </div>
          </div>
        </div>
        {viewMode === 'feed' && feedPack?.err ? <p className="err article-feed-err">{feedPack.err}</p> : null}
        {viewMode === 'feed' && (!feedPack || feedPack.loading) ? (
          <p className="muted">Loading…</p>
        ) : viewMode === 'feed' && feedPack ? (
          <>
            <div className="article-feed-scroll" role="feed" aria-busy={feedPack.loadingMore}>
              {feedPack.items.length === 0 ? (
                <p className="muted article-feed-empty">No articles match the current filters.</p>
              ) : (
                feedPack.items.map((a) => (
                  <ArticleFeedCard
                    key={a.id}
                    article={a}
                    feedName={feedMap.get(a.feed_id)}
                    feedTags={feedTagsByFeedId.get(a.feed_id) ?? EMPTY_FEED_TAGS}
                  />
                ))
              )}
              {feedPack.hasMore ? (
                <div
                  ref={feedSentinelRef}
                  className="article-feed-sentinel"
                  aria-hidden
                />
              ) : feedPack.items.length > 0 ? (
                <p className="muted small article-feed-end">Конец списка</p>
              ) : null}
              {feedPack.loadingMore ? (
                <p className="muted small article-feed-loading-more">Подгрузка…</p>
              ) : null}
            </div>
          </>
        ) : loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {viewMode === 'tiles' ? (
              <div className="article-tiles">
                {articles.length === 0 ? (
                  <p className="muted article-tiles-empty">No articles match the current filters.</p>
                ) : (
                  articles.map((a) => (
                    <ArticleTile
                      key={a.id}
                      article={a}
                      feedName={feedMap.get(a.feed_id)}
                      feedTags={feedTagsByFeedId.get(a.feed_id) ?? EMPTY_FEED_TAGS}
                    />
                  ))
                )}
              </div>
            ) : (
              <ul className="article-list">
                {articles.length === 0 ? (
                  <li className="muted">No articles match the current filters.</li>
                ) : (
                  articles.map((a) => (
                    <ArticleRow
                      key={a.id}
                      article={a}
                      feedName={feedMap.get(a.feed_id)}
                      feedTags={feedTagsByFeedId.get(a.feed_id) ?? EMPTY_FEED_TAGS}
                    />
                  ))
                )}
              </ul>
            )}
            <PaginationBar
              page={page}
              totalPages={totalPages}
              totalItems={total}
              canPrev={page > 0}
              canNext={(page + 1) * limit < total}
              onPrev={() => setParam('page', String(page - 1))}
              onNext={() => setParam('page', String(page + 1))}
            />
          </>
        )}
      </div>
    </>
  );
}

const ArticleVersionPill = memo(function ArticleVersionPill({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span
      className="article-version-pill"
      title={`${count} saved snapshots — open to compare versions`}
    >
      <span className="article-version-pill__icon" aria-hidden>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
        </svg>
      </span>
      Updated
      <span className="article-version-pill__n">{count}</span>
    </span>
  );
});

const ArticleFeedCard = memo(function ArticleFeedCard({
  article: a,
  feedName,
  feedTags,
}: {
  article: Article;
  feedName?: string;
  feedTags: Tag[];
}) {
  const published = formatDateTime(a.published_at ?? undefined);
  const fetched = formatDateTime(a.last_fetched_at);
  const rx = a.telegram_reactions ?? [];
  const tagAccent = feedTags[0]?.color ?? DEFAULT_TAG_COLOR;
  const full = isFullPageArchiveBody(a.body);

  return (
    <article
      className={
        'article-feed-card' + (feedTags.length > 0 ? ' article-feed-card--tagged' : '')
      }
      style={
        feedTags.length > 0
          ? ({ ['--feed-tag-accent' as string]: tagAccent } as CSSProperties)
          : undefined
      }
    >
      <header className="article-feed-card-head">
        <h3 className="article-feed-card-title">
          <Link to={`/articles/${a.id}`}>{a.title || '(no title)'}</Link>
        </h3>
        <ArticleVersionPill count={a.content_version_count} />
      </header>
      {feedName ? (
        <p className="article-feed-card-source small muted">
          <span className="article-feed-card-source__label">Source</span>{' '}
          <span className="article-feed-card-source__name">{feedName}</span>
        </p>
      ) : null}
      <ArticleTagChips tags={feedTags} className="feed-card-tag-chips article-feed-card-tags" />
      {rx.length > 0 ? (
        <div className="article-feed-card-reactions">
          <TelegramReactionsStrip articleId={a.id} reactions={rx} />
        </div>
      ) : null}
      <div className="meta article-feed-card-meta small">
        <span title={published.title}>{published.display}</span>
        <span title={fetched.title}>Fetched {fetched.display}</span>
      </div>
      <div className="article-feed-card-body-wrap">
        {full ? (
          <p className="muted small">
            Полный HTML-архив страницы —{' '}
            <Link to={`/articles/${a.id}`}>открыть на отдельной странице</Link>.
          </p>
        ) : (
          <div
            className="body article-feed-card-body"
            dangerouslySetInnerHTML={{ __html: sanitizeArticleBodyHtml(a.body) }}
          />
        )}
      </div>
    </article>
  );
});

const ArticleTileCover = memo(function ArticleTileCover({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  const showImg = src && !broken;
  if (!showImg) {
    return (
      <div className="article-tile-placeholder" aria-hidden="true">
        <img
          src="/icons/icon.svg"
          alt=""
          className="article-tile-placeholder-mark"
          width={128}
          height={128}
          decoding="async"
        />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      className="article-tile-img"
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
});

const ArticleTile = memo(function ArticleTile({
  article: a,
  feedName,
  feedTags,
}: {
  article: Article;
  feedName?: string;
  feedTags: Tag[];
}) {
  const imgUrl = useMemo(() => firstImageUrlFromArticle(a.body), [a.body]);
  const published = formatDateTime(a.published_at ?? undefined);
  const fetched = formatDateTime(a.last_fetched_at);
  const rx = a.telegram_reactions ?? [];
  const tagAccent = feedTags[0]?.color ?? DEFAULT_TAG_COLOR;

  return (
    <article
      className={
        'article-tile' + (feedTags.length > 0 ? ' article-tile--tagged' : '')
      }
      style={
        feedTags.length > 0
          ? ({ ['--feed-tag-accent' as string]: tagAccent } as CSSProperties)
          : undefined
      }
    >
      <Link to={`/articles/${a.id}`} className="article-tile-link">
        <ArticleTileCover src={imgUrl} />
        <div className="article-tile-body">
          <div className="article-tile-heading-row">
            <h3 className="article-tile-heading">{a.title || '(no title)'}</h3>
            <ArticleVersionPill count={a.content_version_count} />
          </div>
          {feedName ? (
            <p className="article-tile-source">
              <span className="article-tile-source__label">Source</span>
              <span className="article-tile-source__name">{feedName}</span>
            </p>
          ) : null}
          <ArticleTagChips tags={feedTags} className="feed-card-tag-chips article-tile-tag-chips" />
        </div>
      </Link>
      {rx.length > 0 ? (
        <div className="article-tile-reactions">
          <TelegramReactionsStrip articleId={a.id} reactions={rx} />
        </div>
      ) : null}
      <div className="article-tile-meta meta article-tile-meta--dates">
        <span title={published.title}>{published.display}</span>
        <span title={fetched.title}>Fetched {fetched.display}</span>
      </div>
    </article>
  );
});

const ArticleRow = memo(function ArticleRow({
  article: a,
  feedName,
  feedTags,
}: {
  article: Article;
  feedName?: string;
  feedTags: Tag[];
}) {
  const published = formatDateTime(a.published_at ?? undefined);
  const fetched = formatDateTime(a.last_fetched_at);
  const rx = a.telegram_reactions ?? [];
  const tagAccent = feedTags[0]?.color ?? DEFAULT_TAG_COLOR;

  return (
    <li
      className={feedTags.length > 0 ? 'article-row--tagged' : undefined}
      style={
        feedTags.length > 0
          ? ({ ['--feed-tag-accent' as string]: tagAccent } as CSSProperties)
          : undefined
      }
    >
      <div className="article-row-title-row">
        <Link className="article-row-title-link" to={`/articles/${a.id}`}>
          {a.title || '(no title)'}
        </Link>
        <ArticleVersionPill count={a.content_version_count} />
      </div>
      {feedName ? (
        <p className="article-row-source">
          <span className="article-row-source__label">Source</span>
          <span className="article-row-source__name">{feedName}</span>
        </p>
      ) : null}
      <ArticleTagChips tags={feedTags} className="feed-card-tag-chips article-row-tag-chips" />
      {rx.length > 0 ? (
        <div className="article-row-reactions">
          <TelegramReactionsStrip articleId={a.id} reactions={rx} />
        </div>
      ) : null}
      <div className="meta article-row-meta--dates">
        <span title={published.title}>{published.display}</span>
        <span title={fetched.title}>Fetched {fetched.display}</span>
      </div>
    </li>
  );
});

const ArticleTagChips = memo(function ArticleTagChips({
  tags,
  className,
}: {
  tags: Tag[];
  className?: string;
}) {
  if (tags.length === 0) return null;
  return (
    <div className={className} role="list" aria-label="Tags">
      {tags.map((t) => (
        <span
          key={t.id}
          role="listitem"
          className="feed-tag-chip"
          style={{
            backgroundColor: t.color,
            color: pickTagChipTextColor(t.color),
          }}
        >
          {t.name}
        </span>
      ))}
    </div>
  );
});
