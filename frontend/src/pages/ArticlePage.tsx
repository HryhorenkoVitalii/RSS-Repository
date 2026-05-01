import DOMPurify from 'dompurify';
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
} from '../api';
import { NotFoundPage } from './NotFoundPage';
import { TelegramReactionsStrip } from '../TelegramReactionsStrip';
import { formatDateTime } from '../formatTime';
import { markChangedBlocks } from '../articleBlockMarkers';
import {
  htmlToPlainText,
  inlineWordDiffHtml,
  inlineWordDiffTitleHtml,
  type DiffTooltips,
} from '../versionDiff';

export function ArticlePage() {
  const { id } = useParams();
  const numId = Number(id);
  const [data, setData] = useState<ArticleDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

  const { article, versions } = data;
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

  return (
    <>
      <Link to="/" className="back-link">
        ← Back to articles
      </Link>
      <div className="card article">
        <h1 className="card-title">{displayTitle}</h1>
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
        <div className="meta">
          <span>
            Published: {formatDateTime(article.published_at ?? undefined).display}
          </span>
          <span>First seen: {formatDateTime(article.first_seen_at).display}</span>
          <span>Last fetch: {formatDateTime(article.last_fetched_at).display}</span>
          <span>
            {versions.length > 1
              ? `${versions.length} versions stored — latest shown below`
              : `Versions stored: ${versions.length}`}
          </span>
        </div>

        <div className="article-body-unified">
          <LatestArticleBody articleId={article.id} versions={versions} />
        </div>
      </div>
    </>
  );
}

const domPurifyArticle = (html: string) =>
  DOMPurify.sanitize(html, {
    ADD_TAGS: ['video', 'source', 'audio', 'iframe'],
    ADD_ATTR: ['controls', 'preload', 'src', 'type', 'style', 'alt', 'poster', 'allowfullscreen'],
  });

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
          <h2 id="article-diff-modal-title" className="article-diff-modal-title">
            Text changes (word diff)
          </h2>
          <button
            type="button"
            className="article-diff-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {versions.length > 2 ? (
          <div className="article-diff-modal-step">
            <label htmlFor="article-diff-step">Version step</label>
            <select
              id="article-diff-step"
              value={transitionIdx}
              onChange={(e) => setTransitionIdx(Number(e.target.value))}
            >
              {Array.from({ length: versions.length - 1 }, (_, i) => (
                <option key={i} value={i}>
                  Step {i + 1}: {formatDateTime(versions[i].fetched_at).display} →{' '}
                  {formatDateTime(versions[i + 1].fetched_at).display}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="muted small" style={{ margin: '0 0 0.65rem' }}>
            {fromTime.display} → {toTime.display}
          </p>
        )}
        {fromFull || toFull ? (
          <p className="muted small">
            Full-page HTML snapshots cannot be compared as plain text for this step.
          </p>
        ) : (
          <>
            {titleDiffHtml ? (
              <p
                className="diff-title-line diff-title-wrap small"
                dangerouslySetInnerHTML={{ __html: titleDiffHtml }}
              />
            ) : null}
            {bodyDiffHtml.trim() ? (
              <div
                className="body body--diff article-diff-modal-body"
                dangerouslySetInnerHTML={{ __html: bodyDiffHtml }}
              />
            ) : (
              <p className="muted small">
                No plain-text changes in this step (only formatting may differ).
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
}: {
  articleId: number;
  versions: ArticleContentVersion[];
}) {
  const [diffModalOpen, setDiffModalOpen] = useState(false);

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
        setDiffModalOpen(true);
      }
    },
    [canPlainDiffModal],
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
    bodyHtml = domPurifyArticle(sourceHtml);
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

  const explainNote =
    versions.length > 1 && prev != null && !currFull && !prevFull ? (
      <p className="article-body-latest-note muted small">
        Latest text keeps original formatting. Yellow highlights mark blocks that changed since the
        previous save ({prevFetched!.display}). Click a highlight or “Open text diff” for red/green
        word comparison; multiple updates use steps below. Saved {latestFetched.display}.
      </p>
    ) : versions.length > 1 && prev != null && (currFull || prevFull) ? (
      <p className="article-body-latest-note muted small">
        Latest version ({latestFetched.display}). Full-page HTML archives are not diffed
        side-by-side here.
      </p>
    ) : null;

  return (
    <>
      {explainNote}
      {canPlainDiffModal ? (
        <button
          type="button"
          className="article-diff-modal-open-link"
          onClick={() => setDiffModalOpen(true)}
        >
          Open text diff (red/green, all steps)
        </button>
      ) : null}
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
          dangerouslySetInnerHTML={{ __html: domPurifyArticle(latest.body) }}
        />
      ) : (
        <div
          className={canPlainDiffModal ? 'body article-body--diff-clickable' : 'body'}
          onClick={canPlainDiffModal ? handleMarkedBlockClick : undefined}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      )}
      <ArticleVersionDiffModal
        open={diffModalOpen}
        onClose={() => setDiffModalOpen(false)}
        versions={versions}
        initialTransitionIndex={lastTransitionIndex}
      />
    </>
  );
}
