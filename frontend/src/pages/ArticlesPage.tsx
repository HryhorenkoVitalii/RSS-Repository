import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listAllFeeds, listArticles, type Article, type Feed } from '../api';
import { formatDateTime } from '../formatTime';
import { PaginationBar } from '../PaginationBar';

export function ArticlesPage() {
  const [search, setSearch] = useSearchParams();
  const feedId = search.get('feed_id') ?? '';
  const modifiedOnly = search.get('modified_only') === 'true';
  const page = Math.max(0, Number(search.get('page') ?? '0') || 0);
  const dateFrom = search.get('date_from') ?? '';
  const dateTo = search.get('date_to') ?? '';

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
        feedId: feedId || undefined,
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
  }, [feedId, modifiedOnly, page, dateFrom, dateTo]);

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

  function onApplyFilters(e: React.FormEvent) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    setSearch(
      (prev) => {
        const p = new URLSearchParams(prev);
        const fid = (fd.get('feed_id') as string) ?? '';
        if (fid) p.set('feed_id', fid);
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

  const feedOptions = useMemo(
    () =>
      feeds.map((f) => (
        <option key={f.id} value={String(f.id)}>
          {f.title?.trim() || f.url}
        </option>
      )),
    [feeds],
  );

  return (
    <>
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <h2 className="card-title">Filters</h2>
        <form className="filters" onSubmit={onApplyFilters}>
          <div className="form-row" style={{ marginTop: '0.75rem' }}>
            <label>
              Feed
              <select name="feed_id" defaultValue={feedId}>
                <option value="">All feeds</option>
                {feedOptions}
              </select>
            </label>
            <label
              className="small"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: '0.35rem',
              }}
            >
              <input
                type="checkbox"
                name="modified_only"
                value="true"
                defaultChecked={modifiedOnly}
              />
              Modified only (2+ versions)
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
          </div>
        </form>
      </div>

      <div className="card">
        <h2 className="card-title">Articles</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <ul className="article-list">
              {articles.length === 0 ? (
                <li className="muted">No articles match.</li>
              ) : (
                articles.map((a) => <ArticleRow key={a.id} article={a} />)
              )}
            </ul>
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

function ArticleRow({ article: a }: { article: Article }) {
  const published = formatDateTime(a.published_at ?? undefined);
  const fetched = formatDateTime(a.last_fetched_at);
  const versionAt = formatDateTime(a.latest_content_fetched_at);
  const versions =
    a.content_version_count > 1 ? (
      <span className="badge">{a.content_version_count} versions</span>
    ) : null;

  return (
    <li>
      <div>
        <Link to={`/articles/${a.id}`}>{a.title || '(no title)'}</Link> {versions}
      </div>
      <div className="meta">
        <span title={published.title}>Published: {published.display}</span>
        <span title={fetched.title}>Last fetch: {fetched.display}</span>
        {a.content_version_count > 1 ? (
          <span title={versionAt.title}>Version at: {versionAt.display}</span>
        ) : null}
        <span className="mono wrap">guid: {a.guid}</span>
      </div>
    </li>
  );
}
