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
            <span className="toast-icon">{t.ok ? '✓' : '✗'}</span>
            <span className="toast-text">
              <strong>{name}</strong>
              {t.ok ? (
                ' polled successfully'
              ) : (
                <>
                  {' — poll failed'}
                  {t.error ? `: ${t.error}` : ''}
                  <span className="toast-hint"> (feed is still saved)</span>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
