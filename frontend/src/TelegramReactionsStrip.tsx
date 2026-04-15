import { useCallback, useMemo, useState } from 'react';
import {
  getArticleTelegramReactions,
  type ArticleTelegramReaction,
} from './api';
import { formatDateTime } from './formatTime';

type HistoryRow = {
  id: number;
  emoji: string;
  count_display: string;
  observed_at: string;
};

function historyForEmoji(history: HistoryRow[], emoji: string): HistoryRow[] {
  return [...history.filter((h) => h.emoji === emoji)].sort((a, b) =>
    b.observed_at.localeCompare(a.observed_at),
  );
}

function historyTitleText(lines: HistoryRow[]): string {
  if (lines.length === 0) return 'Нет записей об изменениях счётчика.';
  return lines
    .map((h) => {
      const t = formatDateTime(h.observed_at);
      return `${t.display} — ${h.count_display}`;
    })
    .join('\n');
}

function ReactionCurrentCard({
  emoji,
  countDisplay,
  history,
}: {
  emoji: string;
  countDisplay: string;
  history: HistoryRow[];
}) {
  const lines = useMemo(() => historyForEmoji(history, emoji), [history, emoji]);
  const titleTip = useMemo(() => historyTitleText(lines), [lines]);

  return (
    <div className="reaction-current-card-wrap">
      <div className="reaction-current-card" title={titleTip}>
        <span className="reaction-current-card-emoji" aria-hidden>
          {emoji}
        </span>
        <span className="reaction-current-card-count">{countDisplay}</span>
      </div>
      <div className="reaction-current-popover" role="tooltip">
        <div className="reaction-current-popover-title">Изменения счётчика</div>
        {lines.length === 0 ? (
          <p className="muted small reaction-current-popover-empty">
            Записей нет: значение не менялось с момента первого сохранения или ещё не
            фиксировалось при опросе.
          </p>
        ) : (
          <ul className="reaction-current-popover-list">
            {lines.map((h) => {
              const t = formatDateTime(h.observed_at);
              return (
                <li key={h.id}>
                  <time dateTime={h.observed_at} title={t.title}>
                    {t.display}
                  </time>
                  <span className="reaction-current-popover-count">{h.count_display}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

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
  const [currentSnap, setCurrentSnap] = useState<ArticleTelegramReaction[] | null>(null);

  const openPanel = useCallback(async () => {
    setOpen(true);
    setErr(null);
    setLoading(true);
    setCurrentSnap(null);
    setHistory(null);
    try {
      const r = await getArticleTelegramReactions(articleId);
      setHistory(r.history);
      setCurrentSnap(r.current);
    } catch (e) {
      setHistory(null);
      setCurrentSnap(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [articleId]);

  if (reactions.length === 0) return null;

  const displayCurrent = currentSnap ?? reactions;
  const historyForModal = history ?? [];

  return (
    <>
      <button
        type="button"
        className="reaction-strip"
        onClick={() => void openPanel()}
        title="Реакции Telegram: нажмите, чтобы открыть детали"
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
            className="reaction-modal reaction-modal--telegram"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reaction-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="reaction-modal-head">
              <h2 id="reaction-modal-title" className="reaction-modal-title">
                Реакции в Telegram
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
              Ниже — актуальные числа с последнего опроса. Наведите курсор на реакцию, чтобы
              увидеть, когда и каким было значение при каждом зафиксированном изменении.
            </p>
            {err ? <p className="err">{err}</p> : null}
            {loading ? (
              <p className="muted reaction-modal-loading">Загрузка…</p>
            ) : (
              <div className="reaction-modal-current-shell">
                <p className="reaction-modal-current-label">Сейчас</p>
                <div className="reaction-modal-current-grid">
                  {displayCurrent.map((r, i) => (
                    <ReactionCurrentCard
                      key={`${r.emoji}-${i}`}
                      emoji={r.emoji}
                      countDisplay={r.count_display}
                      history={historyForModal}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
