import DOMPurify from 'dompurify';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getArticle, type Article, type ArticleContentVersion } from '../api';
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
  const [data, setData] = useState<{
    article: Article;
    versions: ArticleContentVersion[];
  } | null>(null);
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
  const safeLink = (() => {
    if (!article.link) return null;
    try {
      const u = new URL(article.link);
      if (u.protocol === 'http:' || u.protocol === 'https:') return article.link;
    } catch { /* invalid URL */ }
    return null;
  })();

  const link = safeLink ? (
    <p className="small">
      <a href={safeLink} target="_blank" rel="noopener noreferrer">
        Open link
      </a>
    </p>
  ) : null;

  return (
    <>
      <Link to="/articles" className="back-link">
        ← Back to articles
      </Link>
      <div className="card article">
        <h1 className="card-title">{article.title || '(no title)'}</h1>
        {link}
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

function VersionBlock({
  v,
  index,
  prev,
  total,
}: {
  v: ArticleContentVersion;
  index: number;
  prev: ArticleContentVersion | null;
  total: number;
}) {
  const latest = index === total - 1;
  const fetched = formatDateTime(v.fetched_at);
  const label = versionLabel(index, total);

  let titleBlock: ReactNode = null;
  let bodyHtml: string;

  if (prev == null) {
    bodyHtml = DOMPurify.sanitize(v.body);
  } else {
    const titleDiff = inlineWordDiffTitleHtml(prev.title, v.title);
    if (titleDiff) {
      titleBlock = (
        <p
          className="diff-title-line diff-title-wrap small"
          dangerouslySetInnerHTML={{ __html: titleDiff }}
        />
      );
    }
    const prevPlain = htmlToPlainText(prev.body);
    const nextPlain = htmlToPlainText(v.body);
    bodyHtml = inlineWordDiffHtml(prevPlain, nextPlain);
  }

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
        <div
          className={prev == null ? 'body' : 'body body--diff'}
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
        />
      </div>
    </details>
  );
}
