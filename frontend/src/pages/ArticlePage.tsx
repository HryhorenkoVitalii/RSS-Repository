import DOMPurify from 'dompurify';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  archiveArticleFullPageNow,
  ARTICLE_NOT_FOUND_MESSAGE,
  expandArticleFromLinkNow,
  fetchArticleArchiveBlobUrl,
  getArticle,
  isChromiumScreenshotBody,
  isFullPageArchiveBody,
  type Article,
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
  const navigate = useNavigate();
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
            ? 'Снимок совпадает с предыдущим (байты PNG те же; новая запись не добавлена).'
            : 'Снимок страницы сохранён: открыт список снимков.',
        );
        navigate(`/articles/${numId}/screenshots`);
      }
    } catch (e) {
      setRemoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(false);
    }
  }, [numId, pullMode, navigate]);

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

  const showPull = canExpandArticleFromLink(article);

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
        {link || showPull ? (
          <div className="article-source-row small">
            {link ? <span className="article-source-open">{link}</span> : null}
            {showPull ? (
              <div className="article-pull-from-page">
                <Link to={`/articles/${article.id}/screenshots`} className="muted small article-screenshots-link">
                  Снимки страницы
                </Link>
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
                      Снимок страницы (headless Chromium → PNG, как в браузере)
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
  const currShot = isChromiumScreenshotBody(v.body);
  const prevFull = prev != null && isFullPageArchiveBody(prev.body);
  const prevShot = prev != null && isChromiumScreenshotBody(prev.body);
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
    if (!prevFull && !currFull && !prevShot && !currShot) {
      const prevPlain = htmlToPlainText(prev.body);
      const nextPlain = htmlToPlainText(v.body);
      bodyHtml = inlineWordDiffHtml(prevPlain, nextPlain);
    }
  } else if (!currFull) {
    bodyHtml = domPurifyArticle(v.body);
  }

  const archiveNote =
    currFull || prevFull || currShot || prevShot ? (
      <p className="muted small article-archive-note">
        {currFull
          ? 'Полный HTML в iframe: из сохранённой страницы убираются meta CSP/Permissions-Policy, чтобы подтянулись стили с сайта; переходы по ссылкам и отправка форм отключены.'
          : null}
        {currShot && !currFull
          ? 'Снимок сделан headless Chromium (как при открытии страницы); высота ограничена окном браузера.'
          : null}
        {prev != null && (prevFull || currFull || prevShot || currShot)
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
          ) : currShot ? (
            <span className="badge article-archive-badge">Chromium PNG</span>
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
        ) : prev != null && (prevFull || currFull || prevShot || currShot) ? (
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
