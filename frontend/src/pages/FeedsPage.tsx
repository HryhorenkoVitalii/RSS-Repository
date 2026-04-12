import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createFeed,
  deleteFeed,
  listFeedsPage,
  pollAllFeeds,
  pollFeedNow,
  subscribePollEvents,
  updateFeedInterval,
  type Feed,
  type FeedsResponse,
  type PollEvent,
} from '../api';
import { formatDateTime } from '../formatTime';
import { singleFeedRssAbsoluteUrl, singleFeedRssPath } from '../feedRss';
import { IntervalSelect, snapToNearestPreset } from '../IntervalSelect';
import { PaginationBar } from '../PaginationBar';
import { runTracked } from '../runTracked';

type PollStatus = 'idle' | 'polling' | 'success' | 'error';

export function FeedsPage() {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<FeedsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newUrl, setNewUrl] = useState('');
  const [newInterval, setNewInterval] = useState(600);

  const [pollStatuses, setPollStatuses] = useState<Record<number, PollStatus>>({});
  const [pollAllStatus, setPollAllStatus] = useState<PollStatus>('idle');
  const pendingPollIds = useRef(new Set<number>());

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

  useEffect(() => {
    const unsub = subscribePollEvents(
      (evt: PollEvent) => {
        const status: PollStatus = evt.ok ? 'success' : 'error';
        setPollStatuses((prev) => ({ ...prev, [evt.feed_id]: status }));
        if (!evt.ok && evt.error) {
          setErr((prev) => (prev ? prev + '\n' : '') + `#${evt.feed_id}: ${evt.error}`);
        }

        pendingPollIds.current.delete(evt.feed_id);
        if (pendingPollIds.current.size === 0) {
          setPollAllStatus((s) => (s === 'polling' ? 'idle' : s));
        }

        setTimeout(() => {
          setPollStatuses((prev) => {
            if (prev[evt.feed_id] !== status) return prev;
            const next = { ...prev };
            delete next[evt.feed_id];
            return next;
          });
        }, 3000);

        void load();
      },
      () => {},
    );
    return unsub;
  }, [load]);

  const totalPages =
    data && data.limit > 0 ? Math.ceil(data.total / data.limit) : 1;

  function normalizeUrl(raw: string): string {
    const s = raw.trim();
    if (s && !/^https?:\/\//i.test(s)) return `https://${s}`;
    return s;
  }

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const url = normalizeUrl(newUrl);
    if (!url) return;
    void runTracked(setBusy, setErr, async () => {
      await createFeed(url, newInterval);
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

  async function onPollOne(id: number) {
    setPollStatuses((prev) => ({ ...prev, [id]: 'polling' }));
    pendingPollIds.current.add(id);
    try {
      await pollFeedNow(id);
    } catch (e) {
      setPollStatuses((prev) => ({ ...prev, [id]: 'error' }));
      pendingPollIds.current.delete(id);
      setErr(e instanceof Error ? e.message : String(e));
      setTimeout(() => {
        setPollStatuses((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 3000);
    }
  }

  async function onPollAll() {
    if (!data) return;
    setPollAllStatus('polling');
    for (const f of data.feeds) {
      setPollStatuses((prev) => ({ ...prev, [f.id]: 'polling' }));
      pendingPollIds.current.add(f.id);
    }
    try {
      await pollAllFeeds();
    } catch (e) {
      setPollAllStatus('error');
      setTimeout(() => setPollAllStatus('idle'), 3000);
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function onDelete(feed: Feed) {
    const name = feed.title?.trim() || feed.url;
    if (!confirm(`Delete feed "${name}" and all its articles?`)) return;
    void runTracked(setBusy, setErr, async () => {
      await deleteFeed(feed.id);
      await load();
    });
  }

  const pollAllLabel =
    pollAllStatus === 'polling'
      ? 'Polling…'
      : pollAllStatus === 'success'
        ? 'Done!'
        : pollAllStatus === 'error'
          ? 'Failed'
          : 'Poll all';

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
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com/rss"
              required
            />
          </label>
          <label>
            Poll interval
            <IntervalSelect value={newInterval} onChange={setNewInterval} />
          </label>
          <button type="submit" disabled={busy}>
            Add feed
          </button>
        </form>
      </div>

      <div className="card">
        <div className="card-head">
          <h2 className="card-title">Feeds</h2>
          <button
            type="button"
            className={`btn-secondary${pollAllStatus === 'success' ? ' poll-success' : pollAllStatus === 'error' ? ' poll-error' : ''}`}
            disabled={busy || pollAllStatus === 'polling'}
            onClick={() => void onPollAll()}
          >
            {pollAllLabel}
          </button>
        </div>

        {!data ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            {data.feeds.length === 0 ? (
              <p className="muted">No feeds yet. Add one above.</p>
            ) : (
              <div>
                {data.feeds.map((f) => (
                  <FeedCard
                    key={f.id}
                    feed={f}
                    disabled={busy}
                    pollStatus={pollStatuses[f.id] ?? 'idle'}
                    onSaveInterval={(sec) => onSaveInterval(f, sec)}
                    onPoll={() => void onPollOne(f.id)}
                    onDelete={() => onDelete(f)}
                  />
                ))}
              </div>
            )}
            <PaginationBar
              page={page}
              totalPages={totalPages}
              totalItems={data.total}
              canPrev={page > 0}
              canNext={(page + 1) * data.limit < data.total}
              onPrev={() => setPage((p) => p - 1)}
              onNext={() => setPage((p) => p + 1)}
            />
          </>
        )}
      </div>
    </>
  );
}

function FeedCard({
  feed,
  disabled,
  pollStatus,
  onSaveInterval,
  onPoll,
  onDelete,
}: {
  feed: Feed;
  disabled: boolean;
  pollStatus: PollStatus;
  onSaveInterval: (sec: number) => void;
  onPoll: () => void;
  onDelete: () => void;
}) {
  const rssPath = singleFeedRssPath(feed.id);
  const rssAbsoluteUrl = singleFeedRssAbsoluteUrl(feed.id);

  const [sec, setSec] = useState(() =>
    snapToNearestPreset(feed.poll_interval_seconds),
  );
  const [rssCopied, setRssCopied] = useState(false);
  useEffect(() => {
    setSec(snapToNearestPreset(feed.poll_interval_seconds));
  }, [feed.id, feed.poll_interval_seconds]);

  const title = feed.title?.trim() || '';
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

  const statusIndicator =
    pollStatus === 'polling' ? (
      <span className="poll-badge poll-badge--loading">Polling…</span>
    ) : pollStatus === 'success' ? (
      <span className="poll-badge poll-badge--success">OK</span>
    ) : pollStatus === 'error' ? (
      <span className="poll-badge poll-badge--error">Error</span>
    ) : null;

  const cardClass =
    'feed-card' +
    (pollStatus === 'polling' ? ' feed-card--polling' : '') +
    (pollStatus === 'success' ? ' feed-card--success' : '') +
    (pollStatus === 'error' ? ' feed-card--error' : '');

  return (
    <div className={cardClass}>
      <div className="feed-card-header">
        <span className="feed-card-id">#{feed.id}</span>
        <div className="feed-card-info">
          {title && <div className="feed-card-title" title={title}>{title}</div>}
          <div className="feed-card-url" title={feed.url}>{feed.url}</div>
        </div>
        {statusIndicator}
        <button
          type="button"
          className="btn-ghost btn-compact feed-card-delete"
          disabled={disabled}
          onClick={onDelete}
          title="Delete feed"
        >
          ✕
        </button>
      </div>
      <div className="feed-card-footer">
        <span className="feed-card-polled muted small" title={polled.title}>
          {polled.display}
        </span>
        <div className="feed-card-actions">
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
            disabled={disabled || pollStatus === 'polling'}
            onClick={onPoll}
          >
            {pollStatus === 'polling' ? 'Polling…' : 'Poll'}
          </button>
          <a
            href={rssPath}
            target="_blank"
            rel="noopener noreferrer"
            className="feed-card-rss-link"
            title="Open RSS feed"
          >
            RSS
          </a>
          <button
            type="button"
            className="btn-ghost btn-compact"
            disabled={disabled}
            onClick={() => void copyRssUrl()}
            title={rssAbsoluteUrl}
          >
            {rssCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
