import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
import { feedRssPath } from '../feedRss';
import { formatDateTime } from '../formatTime';
import { PaginationBar } from '../PaginationBar';
import { pickTagChipTextColor } from '../tagChipText';

function parseCommaSepIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

type ArticleViewMode = 'list' | 'tiles';

function parseViewMode(raw: string | null): ArticleViewMode {
  return raw === 'tiles' ? 'tiles' : 'list';
}

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
  const feedIds = parseCommaSepIds(search.get('feed_id'));
  const tagIds = parseCommaSepIds(search.get('tag_id'));
  const modifiedOnly = search.get('modified_only') === 'true';
  const page = Math.max(0, Number(search.get('page') ?? '0') || 0);
  const dateFrom = search.get('date_from') ?? '';
  const dateTo = search.get('date_to') ?? '';
  const viewMode = parseViewMode(search.get('view'));

  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(50);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
    setLoading(true);
    setErr(null);
    try {
      const r = await listArticles({
        feedIds: feedIds.length > 0 ? feedIds : undefined,
        tagIds: tagIds.length > 0 ? tagIds : undefined,
        modifiedOnly,
        page,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      setArticles(r.articles);
      setTotal(r.total);
      setLimit(r.limit);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setArticles([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedIds.join(','), tagIds.join(','), modifiedOnly, page, dateFrom, dateTo]);

  useEffect(() => {
    void load();
  }, [load]);

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
        p.delete('page');
        return p;
      },
      { replace: true },
    );
    setFiltersOpen(false);
  }

  const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;

  const rssParams = useMemo(
    () => ({
      feedIds: feedIds.map(Number).filter((n) => !isNaN(n)),
      tagIds: tagIds.map(Number).filter((n) => !isNaN(n)),
      modifiedOnly,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feedIds.join(','), tagIds.join(','), modifiedOnly, dateFrom, dateTo],
  );

  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersDrawerRef = useRef<HTMLElement | null>(null);

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

  const feedMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of feeds) m.set(f.id, f.title?.trim() || f.url);
    return m;
  }, [feeds]);

  const feedTagsByFeedId = useMemo(() => {
    const m = new Map<number, Tag[]>();
    for (const f of feeds) {
      const tags = (f.tags ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
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
    return bits.length > 0 ? bits.join(' · ') : 'No extra filters';
  }, [feedIds, tagIds, modifiedOnly, dateFrom, dateTo]);

  const articlesScreenDigest = useMemo(() => {
    if (loading) return null;
    return formatArticlesListForAi({
      articles,
      feedTitle: (fid) => feedMap.get(fid),
      filterSummary: `Фильтры: ${activeFilterHint}`,
      page,
      limit,
      total,
    });
  }, [loading, articles, feedMap, activeFilterHint, page, limit, total]);

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
                <form className="filters filters-panel-form" onSubmit={onApplyFilters} ref={formRef}>
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

                  <div className="filters-panel-actions">
                    <button type="submit" className="btn-primary filters-panel-apply">
                      Apply filters
                    </button>
                  </div>

                  <div className="articles-filters-rss-row">
                    <a
                      className="btn-rss-export"
                      href={feedRssPath(rssParams)}
                      target="_blank"
                      rel="noreferrer"
                      title="Export filtered articles as RSS 2.0 feed"
                    >
                      RSS Export
                    </a>
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
            {!loading ? <span className="muted small">{total} total</span> : null}
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
            </div>
          </div>
        </div>
        {loading ? (
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
                      feedTags={feedTagsByFeedId.get(a.feed_id) ?? []}
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
                      feedTags={feedTagsByFeedId.get(a.feed_id) ?? []}
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

function ArticleTileCover({ src }: { src: string | null }) {
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
}

function ArticleTile({
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
  const versions =
    a.content_version_count > 1 ? (
      <span className="badge">{a.content_version_count} ver</span>
    ) : null;
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
          <h3 className="article-tile-heading">{a.title || '(no title)'}</h3>
          {versions ? <div className="article-tile-badges">{versions}</div> : null}
          <ArticleTagChips tags={feedTags} className="feed-card-tag-chips article-tile-tag-chips" />
        </div>
      </Link>
      {rx.length > 0 ? (
        <div className="article-tile-reactions">
          <TelegramReactionsStrip articleId={a.id} reactions={rx} />
        </div>
      ) : null}
      <div className="article-tile-meta meta">
        {feedName && <span>{feedName}</span>}
        <span title={published.title}>{published.display}</span>
        <span title={fetched.title}>Fetched {fetched.display}</span>
      </div>
    </article>
  );
}

function ArticleRow({
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
  const versions =
    a.content_version_count > 1 ? (
      <span className="badge">{a.content_version_count} ver</span>
    ) : null;
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
      <div>
        <Link to={`/articles/${a.id}`}>{a.title || '(no title)'}</Link>
        {versions}
      </div>
      <ArticleTagChips tags={feedTags} className="feed-card-tag-chips article-row-tag-chips" />
      {rx.length > 0 ? (
        <div className="article-row-reactions">
          <TelegramReactionsStrip articleId={a.id} reactions={rx} />
        </div>
      ) : null}
      <div className="meta">
        {feedName && <span>{feedName}</span>}
        <span title={published.title}>{published.display}</span>
        <span title={fetched.title}>Fetched {fetched.display}</span>
      </div>
    </li>
  );
}

function ArticleTagChips({
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
}
