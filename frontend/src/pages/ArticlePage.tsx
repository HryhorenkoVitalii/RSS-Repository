import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { formatArticleDetailForAi } from '../aiScreenDigest';
import { useAiScreenSection } from '../aiScreenContext';
import { Link, useParams } from 'react-router-dom';
import {
  ARTICLE_NOT_FOUND_MESSAGE,
  fetchArticleArchiveBlobUrl,
  getArticle,
  isFullPageArchiveBody,
  type ArticleContentVersion,
  type ArticleDetailResponse,
  type ArticleFeedPreview,
} from '../api';
import { NotFoundPage } from './NotFoundPage';
import { TelegramReactionsStrip } from '../TelegramReactionsStrip';
import { formatDateTime, formatDateTimeCompact } from '../formatTime';
import { markChangedBlocks } from '../articleBlockMarkers';
import { sanitizeArticleBodyHtml } from '../articleHtmlSanitize';
import {
  htmlToPlainText,
  inlineWordDiffHtml,
  inlineWordDiffTitleHtml,
  type DiffTooltips,
} from '../versionDiff';

function articleFeedLabel(feed: ArticleFeedPreview): string {
  const t = feed.title?.trim();
  if (t) return t;
  try {
    return new URL(feed.url).hostname.replace(/^www\./, '');
  } catch {
    return feed.url;
  }
}

export function ArticlePage() {
  const { id } = useParams();
  const numId = Number(id);
  const [data, setData] = useState<ArticleDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [diffModalOpen, setDiffModalOpen] = useState(false);

  useEffect(() => {
    if (!Number.isFinite(numId)) {
      setErr('Invalid id');
      return;
    }
    setErr(null);
    void getArticle(numId)
      .then(setData)
      .catch((e) => {
        setData(null);
        setErr(e instanceof Error ? e.message : String(e));
      });
  }, [numId]);

  const articleDetailDigest = useMemo(() => {
    if (!data?.article) return null;
    return formatArticleDetailForAi(data.article);
  }, [data]);

  useAiScreenSection('article_detail', articleDetailDigest);

  if (err) {
    if (err === ARTICLE_NOT_FOUND_MESSAGE) {
      return <NotFoundPage />;
    }
    return (
      <>
        <Link to="/" className="back-link">
          ← Back to articles
        </Link>
        <p className="err">{err}</p>
      </>
    );
  }

  if (!data) {
    return <p className="muted">Loading…</p>;
  }

  const { article, versions, feed } = data;
  const latestVersion = versions.length > 0 ? versions[versions.length - 1] : null;
  const displayTitle =
    (latestVersion?.title ?? article.title ?? '').trim() || '(no title)';
  const telegramRx = data.telegram_reactions ?? article.telegram_reactions ?? [];
  const safeLink = (() => {
    if (!article.link) return null;
    try {
      const u = new URL(article.link);
      if (u.protocol === 'http:' || u.protocol === 'https:') return article.link;
    } catch { /* invalid URL */ }
    return null;
  })();

  const link = safeLink ? (
    <a href={safeLink} target="_blank" rel="noopener noreferrer">
      Open link
    </a>
  ) : null;

  const publishedCompact = formatDateTimeCompact(article.published_at ?? undefined);
  const hasPublished = publishedCompact.display !== '—';

  return (
    <>
      <Link to="/" className="back-link">
        ← Back to articles
      </Link>
      <div className="card article">
        <h1 className="article-page-title">{displayTitle}</h1>
        {telegramRx.length > 0 ? (
          <div className="article-telegram-reactions">
            <TelegramReactionsStrip articleId={article.id} reactions={telegramRx} />
          </div>
        ) : null}
        {link ? (
          <div className="article-source-row small">
            <span className="article-source-open">{link}</span>
          </div>
        ) : null}
        <div
          className="article-meta-strip"
          role="group"
          aria-label="Article metadata"
        >
          <div className="article-meta-strip-text">
            {feed ? (
              <span className="article-meta-source" title={feed.url}>
                {articleFeedLabel(feed)}
              </span>
            ) : null}
            {feed && hasPublished ? (
              <span className="article-meta-dot" aria-hidden>
                ·
              </span>
            ) : null}
            {hasPublished ? (
              <time
                className="article-meta-published"
                dateTime={article.published_at ?? undefined}
                title={publishedCompact.title}
              >
                <span className="visually-hidden">Published </span>
                {publishedCompact.display}
              </time>
            ) : !feed ? (
              <span className="article-meta-muted">No publication date</span>
            ) : null}
          </div>
          {versions.length > 1 ? (
            <button
              type="button"
              className="article-meta-versions-btn"
              onClick={() => setDiffModalOpen(true)}
              title="Compare saved versions (word-level diff)"
              aria-label={`Compare ${versions.length} saved versions`}
            >
              <span className="article-meta-versions-btn__count">{versions.length}</span>
              <span className="article-meta-versions-btn__label">versions</span>
              <svg
                className="article-meta-versions-btn__icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ) : null}
        </div>

        <div className="article-body-unified">
          <LatestArticleBody
            articleId={article.id}
            versions={versions}
            diffModalOpen={diffModalOpen}
            onOpenDiffModal={() => setDiffModalOpen(true)}
            onCloseDiffModal={() => setDiffModalOpen(false)}
          />
        </div>
      </div>
    </>
  );
}

function ArchiveIframePreview({
  articleId,
  contentId,
}: {
  articleId: number;
  contentId: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let blobUrl: string | null = null;
    let cancelled = false;
    setSrc(null);
    setLoadErr(null);
    void fetchArticleArchiveBlobUrl(articleId, contentId)
      .then((u) => {
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        blobUrl = u;
        setSrc(u);
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [articleId, contentId]);

  if (loadErr) return <p className="err small">{loadErr}</p>;
  if (!src) return <p className="muted small">Загрузка архива…</p>;
  return (
    <iframe
      title="HTML archive"
      className="article-archive-frame"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      src={src}
    />
  );
}

function ArticleVersionDiffModal({
  open,
  onClose,
  versions,
  initialTransitionIndex,
}: {
  open: boolean;
  onClose: () => void;
  versions: ArticleContentVersion[];
  initialTransitionIndex: number;
}) {
  const [transitionIdx, setTransitionIdx] = useState(initialTransitionIndex);

  useEffect(() => {
    if (open) {
      setTransitionIdx(initialTransitionIndex);
    }
  }, [open, initialTransitionIndex]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || versions.length < 2) return null;

  const fromV = versions[transitionIdx];
  const toV = versions[transitionIdx + 1];
  if (!fromV || !toV) return null;

  const fromFull = isFullPageArchiveBody(fromV.body);
  const toFull = isFullPageArchiveBody(toV.body);

  let bodyDiffHtml = '';
  let titleDiffHtml: string | null = null;
  if (!fromFull && !toFull) {
    bodyDiffHtml = inlineWordDiffHtml(
      htmlToPlainText(fromV.body),
      htmlToPlainText(toV.body),
    );
    titleDiffHtml = inlineWordDiffTitleHtml(fromV.title, toV.title);
  }

  const fromTime = formatDateTime(fromV.fetched_at);
  const toTime = formatDateTime(toV.fetched_at);

  return (
    <div className="article-diff-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="article-diff-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="article-diff-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="article-diff-modal-head">
          <div>
            <h2 id="article-diff-modal-title" className="article-diff-modal-title">
              Version comparison
            </h2>
            <p className="article-diff-modal-sub muted small">
              Word-level diff of plain text (formatting may differ).
            </p>
          </div>
          <button
            type="button"
            className="article-diff-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="article-diff-legend" aria-hidden>
          <span className="article-diff-legend-item article-diff-legend-item--add">Added</span>
          <span className="article-diff-legend-item article-diff-legend-item--del">Removed</span>
        </div>
        {versions.length > 2 ? (
          <div className="article-diff-modal-step">
            <label htmlFor="article-diff-step">Transition</label>
            <select
              id="article-diff-step"
              className="article-diff-modal-select"
              value={transitionIdx}
              onChange={(e) => setTransitionIdx(Number(e.target.value))}
            >
              {Array.from({ length: versions.length - 1 }, (_, i) => (
                <option key={i} value={i}>
                  {i + 1}. {formatDateTime(versions[i].fetched_at).display} →{' '}
                  {formatDateTime(versions[i + 1].fetched_at).display}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="article-diff-modal-range muted small">
            <time dateTime={fromV.fetched_at}>{fromTime.display}</time>
            <span className="article-diff-modal-range-arrow" aria-hidden>
              →
            </span>
            <time dateTime={toV.fetched_at}>{toTime.display}</time>
          </p>
        )}
        {fromFull || toFull ? (
          <p className="article-diff-modal-empty muted small">
            Full-page HTML archives can’t be compared as plain text for this step.
          </p>
        ) : (
          <>
            {titleDiffHtml ? (
              <p
                className="diff-title-line diff-title-wrap article-diff-modal-title-diff"
                dangerouslySetInnerHTML={{ __html: titleDiffHtml }}
              />
            ) : null}
            {bodyDiffHtml.trim() ? (
              <div
                className="body body--diff article-diff-modal-body"
                dangerouslySetInnerHTML={{ __html: bodyDiffHtml }}
              />
            ) : (
              <p className="article-diff-modal-empty muted small">
                No text changes in this step — update may be images or layout only.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Single-column article: latest HTML preserve formatting; optional block markers vs previous. */
function LatestArticleBody({
  articleId,
  versions,
  diffModalOpen,
  onOpenDiffModal,
  onCloseDiffModal,
}: {
  articleId: number;
  versions: ArticleContentVersion[];
  diffModalOpen: boolean;
  onOpenDiffModal: () => void;
  onCloseDiffModal: () => void;
}) {
  if (versions.length === 0) {
    return <p className="muted">No saved content versions.</p>;
  }

  const latest = versions[versions.length - 1];
  const prev = versions.length > 1 ? versions[versions.length - 2] : null;

  const latestFetched = formatDateTime(latest.fetched_at);
  const prevFetched = prev != null ? formatDateTime(prev.fetched_at) : null;

  const diffTooltips: DiffTooltips | undefined =
    prev != null && prevFetched != null
      ? {
          added: `Added in this update (${latestFetched.display}). Compared to the previous save (${prevFetched.display}).`,
          removed: `Removed — was in the previous version (${prevFetched.display}). Latest update: ${latestFetched.display}.`,
        }
      : undefined;

  const currFull = isFullPageArchiveBody(latest.body);
  const prevFull = prev != null && isFullPageArchiveBody(prev.body);
  const showArchiveIframe = currFull;

  const canPlainDiffModal =
    versions.length > 1 && prev != null && !currFull && !prevFull;

  const handleMarkedBlockClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!canPlainDiffModal) return;
      const el = e.target as HTMLElement;
      if (el.closest('a, button, input, textarea, select, label')) return;
      if (el.closest('.diff-block-changed, .diff-body-changed')) {
        e.preventDefault();
        onOpenDiffModal();
      }
    },
    [canPlainDiffModal, onOpenDiffModal],
  );

  const lastTransitionIndex = Math.max(0, versions.length - 2);

  let titleBlock: ReactNode = null;
  if (prev != null && diffTooltips != null) {
    const titleDiff = inlineWordDiffTitleHtml(prev.title, latest.title, diffTooltips);
    if (titleDiff) {
      titleBlock = (
        <p
          className="diff-title-line diff-title-wrap small"
          dangerouslySetInnerHTML={{ __html: titleDiff }}
        />
      );
    }
  }

  let bodyHtml = '';
  if (!currFull) {
    let sourceHtml = latest.body;
    if (prev != null && !prevFull) {
      sourceHtml = markChangedBlocks(prev.body, latest.body);
    }
    bodyHtml = sanitizeArticleBodyHtml(sourceHtml);
  }

  const archiveNote =
    currFull || prevFull ? (
      <p className="muted small article-archive-note">
        {currFull
          ? 'Полный HTML в iframe: из сохранённой страницы убираются meta CSP/Permissions-Policy, чтобы подтянулись стили с сайта; переходы по ссылкам и отправка форм отключены.'
          : null}
        {prev != null && (prevFull || currFull)
          ? ' Построчное сравнение с прошлой версией для этих режимов не строится.'
          : null}
      </p>
    ) : null;

  return (
    <>
      {titleBlock}
      {archiveNote}
      {currFull ? (
        <div className="article-archive-badge-row">
          <span className="badge article-archive-badge">HTML archive</span>
        </div>
      ) : null}
      {showArchiveIframe ? (
        <ArchiveIframePreview articleId={articleId} contentId={latest.id} />
      ) : prev != null && (prevFull || currFull) ? (
        <div
          className="body"
          dangerouslySetInnerHTML={{ __html: sanitizeArticleBodyHtml(latest.body) }}
        />
      ) : (
        <div
          className={canPlainDiffModal ? 'body article-body--diff-clickable' : 'body'}
          onClick={canPlainDiffModal ? handleMarkedBlockClick : undefined}
          title={
            canPlainDiffModal
              ? 'Highlighted sections differ from the previous version — click to open comparison.'
              : undefined
          }
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
      <ArticleVersionDiffModal
        open={diffModalOpen}
        onClose={onCloseDiffModal}
        versions={versions}
        initialTransitionIndex={lastTransitionIndex}
      />
    </>
  );
}
