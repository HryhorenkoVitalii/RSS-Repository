import DOMPurify from 'dompurify';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
import {
  htmlToPlainText,
  inlineWordDiffHtml,
  inlineWordDiffTitleHtml,
} from '../versionDiff';
import { versionLabel } from '../versionTitle';

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
        <h1 className="card-title">{article.title || '(no title)'}</h1>
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
          <span>Versions stored: {versions.length}</span>
        </div>

        <div className="body-versions">
          {versions.map((v, i) => (
            <VersionBlock
              key={v.id}
              articleId={article.id}
              v={v}
              index={i}
              prev={i > 0 ? versions[i - 1] : null}
              total={versions.length}
            />
          ))}
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

function VersionBlock({
  articleId,
  v,
  index,
  prev,
  total,
}: {
  articleId: number;
  v: ArticleContentVersion;
  index: number;
  prev: ArticleContentVersion | null;
  total: number;
}) {
  const latest = index === total - 1;
  const fetched = formatDateTime(v.fetched_at);
  const label = versionLabel(index, total);
  const currFull = isFullPageArchiveBody(v.body);
  const prevFull = prev != null && isFullPageArchiveBody(prev.body);
  const showArchiveIframe = currFull;

  let titleBlock: ReactNode = null;
  let bodyHtml = '';

  if (prev != null) {
    const titleDiff = inlineWordDiffTitleHtml(prev.title, v.title);
    if (titleDiff) {
      titleBlock = (
        <p
          className="diff-title-line diff-title-wrap small"
          dangerouslySetInnerHTML={{ __html: titleDiff }}
        />
      );
    }
    if (!prevFull && !currFull) {
      const prevPlain = htmlToPlainText(prev.body);
      const nextPlain = htmlToPlainText(v.body);
      bodyHtml = inlineWordDiffHtml(prevPlain, nextPlain);
    }
  } else if (!currFull) {
    bodyHtml = domPurifyArticle(v.body);
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
    <details
      className={
        latest
          ? 'body-version-details body-version-details--latest'
          : 'body-version-details'
      }
      open={latest}
    >
      <summary className="body-version-summary">
        <span className="body-version-summary-main">
          {label}
          {currFull ? (
            <span className="badge article-archive-badge">HTML archive</span>
          ) : null}
          {index > 0 ? (
            <span className="muted small"> (vs version {index})</span>
          ) : null}
        </span>
        <span className="body-version-fetched" title={fetched.title}>
          {' '}
          — {fetched.display}
        </span>
      </summary>
      <div className="body-version-inner">
        {titleBlock}
        {archiveNote}
        {showArchiveIframe ? (
          <ArchiveIframePreview articleId={articleId} contentId={v.id} />
        ) : prev != null && (prevFull || currFull) ? (
          <div
            className="body body--diff"
            dangerouslySetInnerHTML={{ __html: domPurifyArticle(v.body) }}
          />
        ) : (
          <div
            className={prev == null ? 'body' : 'body body--diff'}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
        )}
      </div>
    </details>
  );
}
