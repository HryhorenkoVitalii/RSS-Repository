import { useCallback, useEffect, useState } from 'react';
import {
  createFeed,
  listFeedsPage,
  pollAllFeeds,
  pollFeedNow,
  updateFeedInterval,
  type Feed,
  type FeedsResponse,
} from '../api';
import { formatDateTime } from '../formatTime';
import { feedRssAbsoluteUrl, feedRssPath } from '../feedRss';
import { IntervalSelect, snapToNearestPreset } from '../IntervalSelect';
import { PaginationBar } from '../PaginationBar';
import { runTracked } from '../runTracked';

export function FeedsPage() {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<FeedsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newUrl, setNewUrl] = useState('');
  const [newInterval, setNewInterval] = useState(600);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await listFeedsPage(page);
      setData(r);
    } catch (e) {
      setData(null);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages =
    data && data.limit > 0 ? Math.ceil(data.total / data.limit) : 1;

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    void runTracked(setBusy, setErr, async () => {
      await createFeed(newUrl.trim(), newInterval);
      setNewUrl('');
      await load();
    });
  }

  function onSaveInterval(feed: Feed, seconds: number) {
    void runTracked(setBusy, setErr, async () => {
      await updateFeedInterval(feed.id, seconds);
      await load();
    });
  }

  function onPollOne(id: number) {
    void runTracked(setBusy, setErr, async () => {
      await pollFeedNow(id);
      await load();
    });
  }

  function onPollAll() {
    void runTracked(setBusy, setErr, async () => {
      await pollAllFeeds();
      await load();
    });
  }

  return (
    <>
      {err ? <p className="err">{err}</p> : null}

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Add feed</h2>
        </div>
        <form className="form-row" onSubmit={onAdd}>
          <label>
            URL
            <input
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://…"
              required
            />
          </label>
          <label>
            Poll interval
            <IntervalSelect value={newInterval} onChange={setNewInterval} />
          </label>
          <button type="submit" disabled={busy}>
            Add
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Feeds</h2>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={onPollAll}
          >
            Poll all
          </button>
        </div>

        {!data ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title / URL</th>
                  <th>Last polled</th>
                  <th>RSS 2.0</th>
                  <th>Interval</th>
                </tr>
              </thead>
              <tbody>
                {data.feeds.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No feeds yet.
                    </td>
                  </tr>
                ) : (
                  data.feeds.map((f) => (
                    <FeedRow
                      key={f.id}
                      feed={f}
                      disabled={busy}
                      onSaveInterval={(sec) => onSaveInterval(f, sec)}
                      onPoll={() => onPollOne(f.id)}
                    />
                  ))
                )}
              </tbody>
            </table>
            <PaginationBar
              page={page}
              totalPages={totalPages}
              totalItems={data.total}
              canPrev={page > 0}
              canNext={(page + 1) * data.limit < data.total}
              onPrev={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
            <p className="muted small" style={{ marginTop: '0.75rem' }}>
              Per-feed RSS uses <code>/feed.xml?feed_id=…</code> on the API host. External readers
              need a reachable URL (not <code>localhost</code> on your laptop for the public
              internet).
            </p>
          </>
        )}
      </div>
    </>
  );
}

function FeedRow({
  feed,
  disabled,
  onSaveInterval,
  onPoll,
}: {
  feed: Feed;
  disabled: boolean;
  onSaveInterval: (sec: number) => void;
  onPoll: () => void;
}) {
  const rssPath = feedRssPath(feed.id);
  const rssAbsoluteUrl = feedRssAbsoluteUrl(feed.id);

  const [sec, setSec] = useState(() =>
    snapToNearestPreset(feed.poll_interval_seconds),
  );
  const [rssCopied, setRssCopied] = useState(false);
  useEffect(() => {
    setSec(snapToNearestPreset(feed.poll_interval_seconds));
  }, [feed.id, feed.poll_interval_seconds]);

  const title = feed.title?.trim() || feed.url;
  const polled = formatDateTime(feed.last_polled_at ?? undefined);

  async function copyRssUrl() {
    try {
      await navigator.clipboard.writeText(rssAbsoluteUrl);
      setRssCopied(true);
      setTimeout(() => setRssCopied(false), 2000);
    } catch {
      window.prompt('Copy this URL:', rssAbsoluteUrl);
    }
  }

  return (
    <tr>
      <td className="small">{feed.id}</td>
      <td className="ellipsis" title={feed.url}>
        <span className="muted mono wrap">{title}</span>
      </td>
      <td className="small">
        <span title={polled.title}>{polled.display}</span>
      </td>
      <td className="rss-cell small">
        <div className="rss-feed-actions">
          <a
            href={rssPath}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-link btn-compact"
            title="Open RSS in browser"
          >
            Open
          </a>
          <button
            type="button"
            className="btn-secondary btn-compact"
            disabled={disabled}
            onClick={() => void copyRssUrl()}
            title={rssAbsoluteUrl}
          >
            {rssCopied ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </td>
      <td className="actions-cell">
        <div className="inline-form">
          <IntervalSelect value={sec} onChange={setSec} />
          <button
            type="button"
            className="btn-secondary btn-compact"
            disabled={disabled}
            onClick={() => onSaveInterval(sec)}
          >
            Save
          </button>
        </div>
        <button
          type="button"
          className="btn-secondary btn-compact"
          disabled={disabled}
          onClick={onPoll}
        >
          Poll now
        </button>
      </td>
    </tr>
  );
}
