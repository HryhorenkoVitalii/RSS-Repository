import { useCallback, useState } from 'react';
import { getArticleTelegramReactions, type ArticleTelegramReaction } from './api';
import { formatDateTime } from './formatTime';

type HistoryRow = {
  id: number;
  emoji: string;
  count_display: string;
  observed_at: string;
};

export function TelegramReactionsStrip({
  articleId,
  reactions,
}: {
  articleId: number;
  reactions: ArticleTelegramReaction[];
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);

  const openPanel = useCallback(async () => {
    setOpen(true);
    setErr(null);
    setLoading(true);
    try {
      const r = await getArticleTelegramReactions(articleId);
      setHistory(r.history);
    } catch (e) {
      setHistory(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [articleId]);

  if (reactions.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="reaction-strip"
        onClick={() => void openPanel()}
        title="Реакции Telegram: нажмите, чтобы увидеть историю изменений счётчиков"
      >
        {reactions.map((r, i) => (
          <span key={`${i}-${r.emoji}`} className="reaction-chip">
            <span className="reaction-chip-emoji" aria-hidden>
              {r.emoji}
            </span>
            <span className="reaction-chip-count">{r.count_display}</span>
          </span>
        ))}
      </button>

      {open ? (
        <div
          className="reaction-modal-backdrop"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div
            className="reaction-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reaction-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reaction-modal-head">
              <h2 id="reaction-modal-title" className="reaction-modal-title">
                История реакций
              </h2>
              <button
                type="button"
                className="btn-ghost btn-compact"
                onClick={() => setOpen(false)}
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>
            <p className="muted small reaction-modal-hint">
              Записи появляются при опросе ленты, если Telegram изменил числа под эмодзи.
            </p>
            {err ? <p className="err">{err}</p> : null}
            {loading ? (
              <p className="muted">Загрузка…</p>
            ) : history && history.length > 0 ? (
              <ul className="reaction-history-list">
                {history.map((h) => {
                  const t = formatDateTime(h.observed_at);
                  return (
                    <li key={h.id}>
                      <span className="reaction-history-emoji">{h.emoji}</span>
                      <span className="reaction-history-count">{h.count_display}</span>
                      <time className="reaction-history-time muted small" title={t.title}>
                        {t.display}
                      </time>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">Пока нет изменений (или реакции не менялись с первого сохранения).</p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
