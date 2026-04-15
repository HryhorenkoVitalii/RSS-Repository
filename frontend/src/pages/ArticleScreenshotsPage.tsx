import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listArticleScreenshots, type ArticleScreenshotEntry } from '../api';
import { formatDateTime } from '../formatTime';

export function ArticleScreenshotsPage() {
  const { id } = useParams();
  const numId = Number(id);
  const [items, setItems] = useState<ArticleScreenshotEntry[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!Number.isFinite(numId)) {
      setErr('Invalid id');
      setLoading(false);
      return;
    }
    setErr(null);
    setLoading(true);
    void listArticleScreenshots(numId)
      .then((rows) => {
        setItems(rows);
        setSelectedId(rows.length > 0 ? rows[0].id : null);
      })
      .catch((e) => {
        setItems([]);
        setSelectedId(null);
        setErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
  }, [numId]);

  const selected = useMemo(
    () => items.find((x) => x.id === selectedId) ?? items[0] ?? null,
    [items, selectedId],
  );

  if (err && !loading) {
    return (
      <>
        <Link to={`/articles/${id}`} className="back-link">
          ← К статье
        </Link>
        <p className="err">{err}</p>
      </>
    );
  }

  return (
    <>
      <Link to={`/articles/${id}`} className="back-link">
        ← К статье
      </Link>
      <div className="card article">
        <h1 className="card-title">Снимки страницы</h1>
        <p className="muted small">
          PNG из headless Chromium. Выберите время снимка — изображение ниже обновится.
        </p>
        {loading ? (
          <p className="muted">Загрузка…</p>
        ) : items.length === 0 ? (
          <p className="muted">Пока нет сохранённых снимков. Сделайте снимок со страницы статьи.</p>
        ) : (
          <>
            <div className="article-screenshots-toolbar">
              <label className="article-pull-mode-label">
                <span className="muted">Время снимка</span>
                <select
                  className="article-page-pull-select"
                  value={selected?.id ?? ''}
                  onChange={(e) => setSelectedId(Number(e.target.value))}
                  aria-label="Выбор снимка по времени"
                >
                  {items.map((row) => {
                    const t = formatDateTime(row.captured_at);
                    return (
                      <option key={row.id} value={row.id}>
                        {t.display}
                      </option>
                    );
                  })}
                </select>
              </label>
              {selected ? (
                <a
                  className="btn-secondary btn-compact"
                  href={selected.media_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть файл в новой вкладке
                </a>
              ) : null}
            </div>
            {selected ? (
              <div className="article-screenshot-preview">
                <img
                  src={selected.media_url}
                  alt="Снимок страницы"
                  loading="lazy"
                  style={{ maxWidth: '100%', height: 'auto' }}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
