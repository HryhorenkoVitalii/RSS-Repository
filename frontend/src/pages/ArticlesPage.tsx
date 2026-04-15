import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  isChromiumScreenshotBody,
  isFullPageArchiveBody,
  listAllFeeds,
  listArticles,
  type Article,
  type Feed,
} from '../api';
import { TelegramReactionsStrip } from '../TelegramReactionsStrip';
import { feedRssPath } from '../feedRss';
import { formatDateTime } from '../formatTime';
import { PaginationBar } from '../PaginationBar';

function parseFeedIds(raw: string | null): string[] {
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
  if (!html || isFullPageArchiveBody(html) || isChromiumScreenshotBody(html)) return null;
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
  const feedIds = parseFeedIds(search.get('feed_id'));
  const modifiedOnly = search.get('modified_only') === 'true';
  const page = Math.max(0, Number(search.get('page') ?? '0') || 0);
  const dateFrom = search.get('date_from') ?? '';
  const dateTo = search.get('date_to') ?? '';
  const viewMode = parseViewMode(search.get('view'));

  const [feeds, setFeeds] = useState<Feed[]>([]);
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

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await listArticles({
        feedIds: feedIds.length > 0 ? feedIds : undefined,
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
  }, [feedIds.join(','), modifiedOnly, page, dateFrom, dateTo]);

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

  function toggleFeed(id: string) {
    setPendingFeedIds((prev) =>
      prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id],
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
  }

  const totalPages = limit > 0 ? Math.ceil(total / limit) : 1;

  const rssParams = useMemo(
    () => ({
      feedIds: feedIds.map(Number).filter((n) => !isNaN(n)),
      modifiedOnly,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feedIds.join(','), modifiedOnly, dateFrom, dateTo],
  );

  const [feedDropdownOpen, setFeedDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setFeedDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const selectedLabel = useMemo(() => {
    if (pendingFeedIds.length === 0) return 'All feeds';
    if (pendingFeedIds.length === 1) {
      const f = feeds.find((f) => String(f.id) === pendingFeedIds[0]);
      return f ? f.title?.trim() || f.url : `Feed #${pendingFeedIds[0]}`;
    }
    return `${pendingFeedIds.length} feeds selected`;
  }, [pendingFeedIds, feeds]);

  const feedMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const f of feeds) m.set(f.id, f.title?.trim() || f.url);
    return m;
  }, [feeds]);

  return (
    <>
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <h2 className="card-title">Filters</h2>
        <form className="filters" onSubmit={onApplyFilters} ref={formRef}>
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <div className="feed-multi-select" ref={dropdownRef}>
              <label>Feeds</label>
              <button
                type="button"
                className="feed-multi-toggle"
                onClick={() => setFeedDropdownOpen((v) => !v)}
              >
                <span className="feed-multi-toggle-text">{selectedLabel}</span>
                <span className="feed-multi-toggle-arrow">{feedDropdownOpen ? '▴' : '▾'}</span>
              </button>
              {feedDropdownOpen && (
                <div className="feed-multi-dropdown">
                  <label className="feed-multi-option">
                    <input
                      type="checkbox"
                      checked={pendingFeedIds.length === 0}
                      onChange={() => setPendingFeedIds([])}
                    />
                    <span>All feeds</span>
                  </label>
                  {feeds.map((f) => (
                    <label key={f.id} className="feed-multi-option">
                      <input
                        type="checkbox"
                        checked={pendingFeedIds.includes(String(f.id))}
                        onChange={() => toggleFeed(String(f.id))}
                      />
                      <span>{f.title?.trim() || f.url}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <label
              className="small"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: '0.4rem',
              }}
            >
              <input
                type="checkbox"
                name="modified_only"
                value="true"
                defaultChecked={modifiedOnly}
              />
              Modified only
            </label>
            <label>
              From
              <input type="date" name="date_from" defaultValue={dateFrom} />
            </label>
            <label>
              To
              <input type="date" name="date_to" defaultValue={dateTo} />
            </label>
            <button type="submit">Apply</button>
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
                    <ArticleTile key={a.id} article={a} feedName={feedMap.get(a.feed_id)} />
                  ))
                )}
              </div>
            ) : (
              <ul className="article-list">
                {articles.length === 0 ? (
                  <li className="muted">No articles match the current filters.</li>
                ) : (
                  articles.map((a) => (
                    <ArticleRow key={a.id} article={a} feedName={feedMap.get(a.feed_id)} />
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

function ArticleTileCover({ src, title }: { src: string | null; title: string }) {
  const [broken, setBroken] = useState(false);
  const showImg = src && !broken;
  if (!showImg) {
    return (
      <div className="article-tile-placeholder">
        <span className="article-tile-placeholder-title">{title || '(no title)'}</span>
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

function ArticleTile({ article: a, feedName }: { article: Article; feedName?: string }) {
  const imgUrl = useMemo(() => firstImageUrlFromArticle(a.body), [a.body]);
  const published = formatDateTime(a.published_at ?? undefined);
  const fetched = formatDateTime(a.last_fetched_at);
  const versions =
    a.content_version_count > 1 ? (
      <span className="badge">{a.content_version_count} ver</span>
    ) : null;
  const rx = a.telegram_reactions ?? [];

  return (
    <article className="article-tile">
      <Link to={`/articles/${a.id}`} className="article-tile-link">
        <ArticleTileCover src={imgUrl} title={a.title || '(no title)'} />
        <div className="article-tile-body">
          <h3 className="article-tile-heading">{a.title || '(no title)'}</h3>
          {versions ? <div className="article-tile-badges">{versions}</div> : null}
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

function ArticleRow({ article: a, feedName }: { article: Article; feedName?: string }) {
  const published = formatDateTime(a.published_at ?? undefined);
  const fetched = formatDateTime(a.last_fetched_at);
  const versions =
    a.content_version_count > 1 ? (
      <span className="badge">{a.content_version_count} ver</span>
    ) : null;
  const rx = a.telegram_reactions ?? [];

  return (
    <li>
      <div>
        <Link to={`/articles/${a.id}`}>{a.title || '(no title)'}</Link>
        {versions}
      </div>
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
