import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createFeed,
  deleteFeed,
  listFeedsPage,
  pollAllFeeds,
  pollFeedNow,
  updateFeedInterval,
  updateFeedExpandFromLink,
  updateFeedTelegramMaxItems,
  type Feed,
  type FeedsResponse,
} from '../api';
import { formatDateTime } from '../formatTime';
import {
  isTelegramFeedUrl,
  singleFeedRssAbsoluteUrl,
  singleFeedRssPath,
} from '../feedRss';
import { IntervalSelect, snapToNearestPreset } from '../IntervalSelect';
import { PaginationBar } from '../PaginationBar';
import { runTracked } from '../runTracked';
import { usePoll, type PollStatus } from '../PollContext';

type FeedSourceKind = 'rss' | 'telegram';

const TELEGRAM_POSTS_MAX = 500;

function clampTelegramMaxItems(n: number): number {
  if (!Number.isFinite(n)) return TELEGRAM_POSTS_MAX;
  return Math.max(1, Math.min(TELEGRAM_POSTS_MAX, Math.round(n)));
}

function buildFeedUrl(raw: string, source: FeedSourceKind): string {
  const s = raw.trim();
  if (!s) return '';
  if (source === 'rss') {
    if (!/^https?:\/\//i.test(s)) return `https://${s}`;
    return s;
  }
  if (s.startsWith('@')) return s;
  if (/^https?:\/\//i.test(s)) return s;
  const noScheme = s.replace(/^https?:\/\//i, '');
  if (/^(t\.me|telegram\.me)\b/i.test(noScheme)) {
    return `https://${noScheme}`;
  }
  if (/^[a-zA-Z0-9_]{4,32}$/.test(s)) return `@${s}`;
  return s;
}

export function FeedsPage() {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<FeedsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [feedSource, setFeedSource] = useState<FeedSourceKind>('rss');
  const [newUrl, setNewUrl] = useState('');
  const [newInterval, setNewInterval] = useState(600);
  const [newTelegramMaxItems, setNewTelegramMaxItems] = useState(500);
  const [newExpandFromLink, setNewExpandFromLink] = useState(false);

  const {
    pollStatuses,
    pollAllStatus,
    setPollStatus,
    startPollAll,
    addPendingPoll,
    setFeedNames,
  } = usePoll();

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

  // Keep feed names in sync for toast messages
  const prevFeedsRef = useRef<string>('');
  useEffect(() => {
    if (!data) return;
    const names: Record<number, string> = {};
    for (const f of data.feeds) {
      names[f.id] = f.title?.trim() || f.url;
    }
    const key = JSON.stringify(names);
    if (key !== prevFeedsRef.current) {
      prevFeedsRef.current = key;
      setFeedNames(names);
    }
  }, [data, setFeedNames]);

  // Reload feed list when a poll completes
  useEffect(() => {
    const feedIds = data?.feeds.map((f) => f.id) ?? [];
    const hasFinished = feedIds.some((id) => {
      const s = pollStatuses[id];
      return s === 'success' || s === 'error';
    });
    if (hasFinished) {
      void load();
    }
  }, [pollStatuses, data, load]);

  const totalPages =
    data && data.limit > 0 ? Math.ceil(data.total / data.limit) : 1;

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    const url = buildFeedUrl(newUrl, feedSource);
    if (!url) return;
    void runTracked(setBusy, setErr, async () => {
      await createFeed({
        url,
        pollIntervalSeconds: newInterval,
        telegramMaxItems:
          feedSource === 'telegram' ? clampTelegramMaxItems(newTelegramMaxItems) : undefined,
        expandArticleFromLink:
          feedSource === 'rss' && newExpandFromLink ? true : undefined,
      });
      setNewUrl('');
      setNewExpandFromLink(false);
      await load();
    });
  }

  function onSaveInterval(feed: Feed, seconds: number) {
    void runTracked(setBusy, setErr, async () => {
      await updateFeedInterval(feed.id, seconds);
      await load();
    });
  }

  function onSaveTelegramMax(feed: Feed, n: number) {
    void runTracked(setBusy, setErr, async () => {
      await updateFeedTelegramMaxItems(feed.id, clampTelegramMaxItems(n));
      await load();
    });
  }

  function onSaveExpandFromLink(feed: Feed, enabled: boolean) {
    void runTracked(setBusy, setErr, async () => {
      await updateFeedExpandFromLink(feed.id, enabled);
      await load();
    });
  }

  async function onPollOne(id: number) {
    addPendingPoll(id);
    try {
      await pollFeedNow(id);
    } catch (e) {
      setPollStatus(id, 'error');
      setErr(e instanceof Error ? e.message : String(e));
      setTimeout(() => setPollStatus(id, 'idle'), 3000);
    }
  }

  async function onPollAll() {
    if (!data) return;
    const ids = data.feeds.map((f) => f.id);
    startPollAll(ids);
    try {
      await pollAllFeeds();
    } catch (e) {
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
            Source
            <select
              value={feedSource}
              onChange={(e) => setFeedSource(e.target.value as FeedSourceKind)}
              aria-label="Feed source type"
            >
              <option value="rss">RSS / Atom (URL)</option>
              <option value="telegram">Telegram (public channel)</option>
            </select>
          </label>
          <label>
            {feedSource === 'rss' ? 'Feed URL' : 'Channel'}
            <input
              type="text"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder={
                feedSource === 'rss'
                  ? 'https://example.com/rss'
                  : '@channel or t.me/channel'
              }
              required
            />
          </label>
          {feedSource === 'telegram' ? (
            <label>
              Max posts per poll
              <input
                type="number"
                min={1}
                max={TELEGRAM_POSTS_MAX}
                step={1}
                value={newTelegramMaxItems}
                onChange={(e) =>
                  setNewTelegramMaxItems(clampTelegramMaxItems(Number(e.target.value)))
                }
                title={`1–${TELEGRAM_POSTS_MAX} newest messages from Telegram preview`}
              />
            </label>
          ) : null}
          {feedSource === 'rss' ? (
            <label className="form-row-checkbox">
              <input
                type="checkbox"
                checked={newExpandFromLink}
                onChange={(e) => setNewExpandFromLink(e.target.checked)}
              />
              <span>
                Fetch full article from item link when the feed only has a short summary
              </span>
            </label>
          ) : null}
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
                    onSaveTelegramMax={(n) => onSaveTelegramMax(f, n)}
                    onSaveExpandFromLink={(v) => onSaveExpandFromLink(f, v)}
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
  onSaveTelegramMax,
  onSaveExpandFromLink,
  onPoll,
  onDelete,
}: {
  feed: Feed;
  disabled: boolean;
  pollStatus: PollStatus;
  onSaveInterval: (sec: number) => void;
  onSaveTelegramMax: (n: number) => void;
  onSaveExpandFromLink: (enabled: boolean) => void;
  onPoll: () => void;
  onDelete: () => void;
}) {
  const rssPath = singleFeedRssPath(feed.id);
  const rssAbsoluteUrl = singleFeedRssAbsoluteUrl(feed.id);

  const [sec, setSec] = useState(() =>
    snapToNearestPreset(feed.poll_interval_seconds),
  );
  const [tgMax, setTgMax] = useState(() => clampTelegramMaxItems(feed.telegram_max_items));
  const [expandFrom, setExpandFrom] = useState(feed.expand_article_from_link);
  const [rssCopied, setRssCopied] = useState(false);
  const isTelegram = isTelegramFeedUrl(feed.url);
  useEffect(() => {
    setSec(snapToNearestPreset(feed.poll_interval_seconds));
  }, [feed.id, feed.poll_interval_seconds]);
  useEffect(() => {
    setTgMax(clampTelegramMaxItems(feed.telegram_max_items));
  }, [feed.id, feed.telegram_max_items]);
  useEffect(() => {
    setExpandFrom(feed.expand_article_from_link);
  }, [feed.id, feed.expand_article_from_link]);

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
        <Link
          className="feed-card-header-link"
          to={`/articles?feed_id=${feed.id}`}
          title="View articles from this feed"
        >
          <span className="feed-card-id">#{feed.id}</span>
          <div className="feed-card-info">
            {title && <div className="feed-card-title" title={title}>{title}</div>}
            <div className="feed-card-url" title={feed.url}>{feed.url}</div>
          </div>
        </Link>
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
          {isTelegram ? (
            <div className="inline-form" title="Telegram: newest posts to fetch each poll">
              <label className="muted small feed-card-tg-label">
                Posts max
              </label>
              <input
                type="number"
                className="feed-card-tg-max"
                min={1}
                max={TELEGRAM_POSTS_MAX}
                step={1}
                value={tgMax}
                onChange={(e) => setTgMax(clampTelegramMaxItems(Number(e.target.value)))}
                disabled={disabled}
                aria-label="Max Telegram posts per poll"
              />
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={disabled}
                onClick={() => onSaveTelegramMax(tgMax)}
              >
                Save
              </button>
            </div>
          ) : null}
          {!isTelegram ? (
            <div className="inline-form feed-card-expand-row" title="RSS: open each item URL when the feed body is very short">
              <label className="feed-card-expand-label">
                <input
                  type="checkbox"
                  checked={expandFrom}
                  onChange={(e) => setExpandFrom(e.target.checked)}
                  disabled={disabled}
                />
                <span className="muted small">Expand from link</span>
              </label>
              <button
                type="button"
                className="btn-secondary btn-compact"
                disabled={disabled || expandFrom === feed.expand_article_from_link}
                onClick={() => onSaveExpandFromLink(expandFrom)}
              >
                Save
              </button>
            </div>
          ) : null}
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
