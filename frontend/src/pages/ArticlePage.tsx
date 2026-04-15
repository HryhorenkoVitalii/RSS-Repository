import DOMPurify from 'dompurify';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  archiveArticleFullPageNow,
  expandArticleFromLinkNow,
  fetchArticleArchiveBlobUrl,
  getArticle,
  isFullPageArchiveBody,
  type Article,
  type ArticleContentVersion,
  type ArticleDetailResponse,
} from '../api';
import { TelegramReactionsStrip } from '../TelegramReactionsStrip';
import { formatDateTime } from '../formatTime';
import {
  htmlToPlainText,
  inlineWordDiffHtml,
  inlineWordDiffTitleHtml,
} from '../versionDiff';
import { versionLabel } from '../versionTitle';

function canExpandArticleFromLink(article: Article): boolean {
  const u = article.link?.trim();
  if (u?.startsWith('http://') || u?.startsWith('https://')) return true;
  const g = article.guid.trim();
  return g.startsWith('http://') || g.startsWith('https://');
}

const PAGE_PULL_MODE_KEY = 'rss_article_page_pull_mode';

type PagePullMode = 'extract' | 'archive';

function readStoredPullMode(): PagePullMode {
  try {
    return sessionStorage.getItem(PAGE_PULL_MODE_KEY) === 'archive'
      ? 'archive'
      : 'extract';
  } catch {
    return 'extract';
  }
}

export function ArticlePage() {
  const { id } = useParams();
  const numId = Number(id);
  const [data, setData] = useState<ArticleDetailResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pullMode, setPullModeState] = useState<PagePullMode>(readStoredPullMode);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteMsg, setRemoteMsg] = useState<string | null>(null);
  const [remoteErr, setRemoteErr] = useState<string | null>(null);

  const setPullMode = useCallback((m: PagePullMode) => {
    setPullModeState(m);
    try {
      sessionStorage.setItem(PAGE_PULL_MODE_KEY, m);
    } catch {
      /* ignore */
    }
  }, []);

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

  const onLoadFromSourcePage = useCallback(async () => {
    if (!Number.isFinite(numId)) return;
    setRemoteBusy(true);
    setRemoteErr(null);
    setRemoteMsg(null);
    try {
      const res =
        pullMode === 'extract'
          ? await expandArticleFromLinkNow(numId)
          : await archiveArticleFullPageNow(numId);
      setData({
        article: res.article,
        versions: res.versions,
        ...(res.telegram_reactions
          ? { telegram_reactions: res.telegram_reactions }
          : {}),
      });
      if (pullMode === 'extract') {
        setRemoteMsg(
          res.unchanged
            ? 'Страница совпадает с уже сохранённым текстом (новая версия не создана).'
            : 'Основной текст со страницы сохранён как новая версия.',
        );
      } else {
        setRemoteMsg(
          res.unchanged
            ? 'Полный HTML совпадает с уже сохранённым (новая версия не создана).'
            : 'Сохранён полный HTML страницы (новая версия; ниже в iframe).',
        );
      }
    } catch (e) {
      setRemoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(false);
    }
  }, [numId, pullMode]);

  if (err) {
    return (
      <>
        <Link to="/articles" className="back-link">
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

  const showPull = canExpandArticleFromLink(article);

  return (
    <>
      <Link to="/articles" className="back-link">
        ← Back to articles
      </Link>
      <div className="card article">
        <h1 className="card-title">{article.title || '(no title)'}</h1>
        {telegramRx.length > 0 ? (
          <div className="article-telegram-reactions">
            <TelegramReactionsStrip articleId={article.id} reactions={telegramRx} />
          </div>
        ) : null}
        {link || showPull ? (
          <div className="article-source-row small">
            {link ? <span className="article-source-open">{link}</span> : null}
            {showPull ? (
              <div className="article-pull-from-page">
                <label className="article-pull-mode-label">
                  <span className="muted">Тип загрузки</span>
                  <select
                    className="article-page-pull-select"
                    value={pullMode}
                    onChange={(e) => setPullMode(e.target.value as PagePullMode)}
                    disabled={remoteBusy}
                    aria-label="Тип загрузки со страницы по ссылке"
                  >
                    <option value="extract">
                      Основной текст (вырезанный блок, как в RSS expand)
                    </option>
                    <option value="archive">
                      Целая страница (полный HTML, до 8 МБ, просмотр в iframe)
                    </option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-secondary btn-compact"
                  disabled={remoteBusy}
                  onClick={() => void onLoadFromSourcePage()}
                >
                  {remoteBusy ? 'Загрузка…' : 'Загрузить со страницы'}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {remoteErr ? <p className="err article-pull-err">{remoteErr}</p> : null}
        {remoteMsg && !remoteErr ? (
          <p className="muted small article-pull-msg">{remoteMsg}</p>
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
          <p className="body-versions-hint small muted">
            <ins className="diff-legend diff-ins">green</ins> — added vs previous
            version;{' '}
            <del className="diff-legend diff-del">red</del> — removed.
          </p>
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
          ? 'Полный HTML страницы в песочнице: стили и скрипты грузятся как у источника (ограничения браузера и CSP сайта могут что‑то сломать).'
          : null}
        {prev != null && (prevFull || currFull)
          ? ' Построчное сравнение с прошлой версией для архива не строится.'
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
          {currFull ? <span className="badge article-archive-badge">HTML archive</span> : null}
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
