import { usePoll } from './PollContext';

export function Toasts() {
  const { toasts, dismissToast, feedNames } = usePoll();

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((t) => {
        const name = feedNames[t.feedId] || `Feed #${t.feedId}`;
        return (
          <div
            key={t.id}
            className={`toast ${t.ok ? 'toast--success' : 'toast--error'}`}
            onClick={() => dismissToast(t.id)}
          >
            <span className="toast-icon">{t.ok ? '\u2713' : '\u2717'}</span>
            <span className="toast-text">
              <strong>{name}</strong>
              {t.ok ? ' polled successfully' : ` failed${t.error ? `: ${t.error}` : ''}`}
            </span>
          </div>
        );
      })}
    </div>
  );
}
