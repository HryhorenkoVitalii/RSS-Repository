import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearOpenRouterDebugLog,
  getOpenRouterDebugLog,
  OPENROUTER_DEBUG_LOG_EVENT,
  type OpenRouterDebugEntry,
  type OpenRouterDebugMessage,
} from './openRouterDebugLog';

type Props = {
  open: boolean;
  onClose: () => void;
};

function roleLabel(role: string): string {
  switch (role) {
    case 'system':
      return 'system (промпт + контекст экрана)';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    default:
      return role;
  }
}

function OpenRouterLogMessageBlock({ msg, index }: { msg: OpenRouterDebugMessage; index: number }) {
  const safeRole = ['system', 'user', 'assistant'].includes(msg.role) ? msg.role : 'unknown';
  return (
    <div className={`openrouter-debug-msg openrouter-debug-msg--${safeRole}`}>
      <div className="openrouter-debug-msg-head">
        <span className="openrouter-debug-msg-idx">#{index + 1}</span>
        <span className="openrouter-debug-msg-role">{roleLabel(msg.role)}</span>
      </div>
      <pre className="openrouter-debug-msg-body">{msg.content}</pre>
    </div>
  );
}

function OpenRouterLogEntry({ entry, defaultOpen }: { entry: OpenRouterDebugEntry; defaultOpen: boolean }) {
  const [copyDone, setCopyDone] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (defaultOpen && detailsRef.current) detailsRef.current.open = true;
  }, [defaultOpen]);

  function copyEntryJson() {
    void navigator.clipboard
      .writeText(JSON.stringify(entry, null, 2))
      .then(() => {
        setCopyDone(true);
        window.setTimeout(() => setCopyDone(false), 1500);
      })
      .catch(() => {});
  }

  let responseIntro: string;
  if (entry.outcome === 'success') {
    responseIntro = 'Текст ответа модели (choices[0].message.content):';
  } else if (entry.outcome === 'error') {
    responseIntro = 'Ошибка:';
  } else {
    responseIntro = 'Запрос прерван (abort) до обработки ответа.';
  }

  return (
    <details ref={detailsRef} className="openrouter-debug-item">
      <summary className="openrouter-debug-summary">
        <span className={`openrouter-debug-badge openrouter-debug-badge--${entry.outcome}`}>{entry.outcome}</span>
        <span className="openrouter-debug-meta">
          {entry.at} · {entry.model}
          {entry.httpStatus != null ? ` · HTTP ${entry.httpStatus}` : ''}
        </span>
      </summary>
      <div className="openrouter-debug-item-inner">
        <div className="openrouter-debug-section">
          <h3 className="openrouter-debug-section-title">Запрос (как ушёл в OpenRouter)</h3>
          <p className="openrouter-debug-model muted small">
            Модель: <code className="openrouter-debug-code">{entry.model}</code>
          </p>
          <p className="openrouter-debug-count muted small">
            Сообщений в теле запроса: {entry.messages.length} — ниже каждое целиком (включая полный system).
          </p>
          <div className="openrouter-debug-msg-stack">
            {entry.messages.map((m, i) => (
              <OpenRouterLogMessageBlock key={`${entry.id}-m-${i}`} msg={m} index={i} />
            ))}
          </div>
        </div>

        <div className="openrouter-debug-section">
          <h3 className="openrouter-debug-section-title">Ответ API</h3>
          <p className="muted small openrouter-debug-response-intro">{responseIntro}</p>
          {entry.outcome === 'success' && entry.assistantContent != null ? (
            <pre className="openrouter-debug-response-body">{entry.assistantContent}</pre>
          ) : null}
          {entry.outcome === 'error' && entry.errorMessage ? (
            <pre className="openrouter-debug-response-body openrouter-debug-response-body--err">{entry.errorMessage}</pre>
          ) : null}
          {entry.outcome === 'aborted' ? (
            <p className="muted small">Тело ответа могло не успеть записаться.</p>
          ) : null}
          {entry.rawResponseTruncated ? (
            <details className="openrouter-debug-subdetails">
              <summary>Сырой JSON ответа (усечён в логе)</summary>
              <pre className="openrouter-debug-pre openrouter-debug-pre--raw">{entry.rawResponseTruncated}</pre>
            </details>
          ) : null}
        </div>

        <div className="openrouter-debug-entry-actions">
          <button
            type="button"
            className="btn-secondary btn-compact"
            onClick={(ev) => {
              ev.stopPropagation();
              copyEntryJson();
            }}
          >
            {copyDone ? 'Скопировано' : 'Копировать эту запись (JSON)'}
          </button>
        </div>

        <details className="openrouter-debug-subdetails openrouter-debug-subdetails--json">
          <summary>Полная запись одним JSON</summary>
          <pre className="openrouter-debug-pre openrouter-debug-pre--fulljson" tabIndex={0}>
            {JSON.stringify(entry, null, 2)}
          </pre>
        </details>
      </div>
    </details>
  );
}

export function OpenRouterDebugLogPanel({ open, onClose }: Props) {
  const [entries, setEntries] = useState<OpenRouterDebugEntry[]>(() => getOpenRouterDebugLog());

  const refresh = useCallback(() => setEntries(getOpenRouterDebugLog()), []);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    function onUpdate() {
      refresh();
    }
    window.addEventListener(OPENROUTER_DEBUG_LOG_EVENT, onUpdate);
    window.addEventListener('storage', onUpdate);
    return () => {
      window.removeEventListener(OPENROUTER_DEBUG_LOG_EVENT, onUpdate);
      window.removeEventListener('storage', onUpdate);
    };
  }, [refresh]);

  const jsonAll = useMemo(() => JSON.stringify(entries, null, 2), [entries]);

  function onCopyAll() {
    void navigator.clipboard.writeText(jsonAll).catch(() => {});
  }

  function onClear() {
    if (!confirm('Удалить все записи лога OpenRouter в этом браузере?')) return;
    clearOpenRouterDebugLog();
    refresh();
  }

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="openrouter-debug-overlay" role="presentation">
      <div
        className="openrouter-debug-backdrop"
        onClick={onClose}
        aria-hidden
      />
      <div
        className="openrouter-debug-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="openrouter-debug-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="openrouter-debug-head">
          <h2 id="openrouter-debug-title" className="openrouter-debug-title">
            Debug · лог OpenRouter
          </h2>
          <div className="openrouter-debug-actions">
            <button type="button" className="btn-secondary btn-compact" onClick={onCopyAll} disabled={entries.length === 0}>
              Копировать всё (JSON)
            </button>
            <button type="button" className="btn-secondary btn-compact" onClick={onClear} disabled={entries.length === 0}>
              Очистить
            </button>
            <button type="button" className="btn-ghost btn-compact" onClick={onClose} aria-label="Закрыть">
              ✕
            </button>
          </div>
        </div>
        <p className="muted small openrouter-debug-hint">
          Ниже по шагам: <strong>запрос</strong> (модель и каждое сообщение — system, user, assistant — полным текстом), затем{' '}
          <strong>ответ</strong> (текст модели или ошибка, плюс при необходимости сырой JSON). Данные из{' '}
          <code className="openrouter-debug-code">localStorage</code> этой вкладки; ключ в лог не попадает.
        </p>
        {entries.length === 0 ? (
          <p className="muted openrouter-debug-empty">Пока нет запросов к OpenRouter.</p>
        ) : (
          <div className="openrouter-debug-list">
            {entries.map((e, index) => (
              <OpenRouterLogEntry key={e.id} entry={e} defaultOpen={index === 0} />
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
