import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

function SparklesIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063A2 2 0 0 0 14.063 8.5l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </svg>
  );
}

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
};

const WELCOME_TEXT =
  'Привет! Здесь будет чат с ИИ по лентам и статьям. Сейчас ответы только локальные (сервер не подключён) — но окно уже как в мессенджере: история, ввод и отправка.';

const STUB_REPLY =
  'Подключение к модели пока не настроено. Это заглушка: ваше сообщение никуда не уходит, история хранится только в этой вкладке браузера.';

function newMsgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

type Props = {
  fabVisible: boolean;
  onFabDismiss: () => void;
};

export function AiAssistantFab({ fabVisible, onFabDismiss }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([
    { id: 'welcome', role: 'assistant', text: WELCOME_TEXT },
  ]);
  const [draft, setDraft] = useState('');
  const listEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion() === true;
  const titleId = useId();
  const inputId = useId();
  const replyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!fabVisible) setOpen(false);
  }, [fabVisible]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listEndRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' });
  }, [messages, open, reduceMotion]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => textareaRef.current?.focus(), 120);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    return () => {
      if (replyTimerRef.current != null) window.clearTimeout(replyTimerRef.current);
    };
  }, []);

  function hideFab() {
    setOpen(false);
    onFabDismiss();
  }

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    const userId = newMsgId();
    setMessages((m) => [...m, { id: userId, role: 'user', text }]);
    setDraft('');
    if (replyTimerRef.current != null) window.clearTimeout(replyTimerRef.current);
    replyTimerRef.current = window.setTimeout(() => {
      replyTimerRef.current = null;
      setMessages((m) => [...m, { id: newMsgId(), role: 'assistant', text: STUB_REPLY }]);
    }, 420);
  }, [draft]);

  const ease = [0.4, 0, 0.2, 1] as const;

  const fabEnter = reduceMotion
    ? { opacity: 0 }
    : { opacity: 0, y: 8, scale: 0.98 };
  const fabAnimate = reduceMotion
    ? { opacity: 1, transition: { duration: 0.2, ease: ease } }
    : {
        opacity: 1,
        y: 0,
        scale: 1,
        transition: { duration: 0.32, ease: ease },
      };
  const fabExit = reduceMotion
    ? { opacity: 0, transition: { duration: 0.16, ease: ease } }
    : {
        opacity: 0,
        x: 16,
        y: 6,
        scale: 0.94,
        transition: { duration: 0.28, ease: ease },
      };

  const messengerEase = ease;
  const backdropMotion = reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.22, ease: messengerEase } },
        exit: { opacity: 0, transition: { duration: 0.18, ease: messengerEase } },
      };
  const windowMotion = reduceMotion
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : {
        initial: { opacity: 0, x: 20, scale: 0.99 },
        animate: {
          opacity: 1,
          x: 0,
          scale: 1,
          transition: { duration: 0.32, ease: messengerEase },
        },
        exit: { opacity: 0, x: 12, scale: 0.995, transition: { duration: 0.22, ease: messengerEase } },
      };

  const portal =
    typeof document !== 'undefined'
      ? createPortal(
          <AnimatePresence>
            {open ? (
              <>
                <motion.div
                  key="ai-messenger-backdrop"
                  className="ai-assistant-messenger-backdrop"
                  role="presentation"
                  aria-hidden
                  initial={backdropMotion.initial}
                  animate={backdropMotion.animate}
                  exit={backdropMotion.exit}
                  onClick={() => setOpen(false)}
                />
                <motion.div
                  key="ai-messenger-wrap"
                  className="ai-assistant-messenger-wrap"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: reduceMotion ? 0.12 : 0.2, ease: messengerEase } }}
                  exit={{ opacity: 0, transition: { duration: 0.15, ease: messengerEase } }}
                >
                  <motion.div
                    className="ai-assistant-messenger"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={titleId}
                    initial={windowMotion.initial}
                    animate={windowMotion.animate}
                    exit={windowMotion.exit}
                    onClick={(e) => e.stopPropagation()}
                  >
                  <header className="ai-assistant-messenger-head">
                    <div className="ai-assistant-messenger-head-main">
                      <span className="ai-assistant-messenger-avatar" aria-hidden>
                        <SparklesIcon className="ai-assistant-messenger-avatar-icon" />
                      </span>
                      <div>
                        <h2 id={titleId} className="ai-assistant-messenger-title">
                          ИИ‑ассистент
                        </h2>
                        <p className="ai-assistant-messenger-subtitle muted small">
                          Локальный чат · без сервера
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-ghost btn-compact ai-assistant-messenger-close"
                      onClick={() => setOpen(false)}
                      aria-label="Закрыть"
                    >
                      ✕
                    </button>
                  </header>

                  <div
                    className="ai-assistant-messenger-thread"
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions"
                  >
                    {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`ai-assistant-messenger-row ai-assistant-messenger-row--${msg.role}`}
                      >
                        <div className="ai-assistant-messenger-bubble">{msg.text}</div>
                      </div>
                    ))}
                    <div ref={listEndRef} className="ai-assistant-messenger-thread-end" aria-hidden />
                  </div>

                  <form
                    className="ai-assistant-messenger-composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      send();
                    }}
                  >
                    <label htmlFor={inputId} className="visually-hidden">
                      Сообщение
                    </label>
                    <textarea
                      id={inputId}
                      ref={textareaRef}
                      className="ai-assistant-messenger-input"
                      rows={2}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          send();
                        }
                      }}
                      placeholder="Напишите сообщение… (Enter — отправить, Shift+Enter — новая строка)"
                      maxLength={8000}
                    />
                    <button
                      type="submit"
                      className="btn-primary ai-assistant-messenger-send"
                      disabled={!draft.trim()}
                    >
                      Отправить
                    </button>
                  </form>
                  </motion.div>
                </motion.div>
              </>
            ) : null}
          </AnimatePresence>,
          document.body,
        )
      : null;

  return (
    <>
      {portal}
      <div className="ai-assistant-dock">
        <AnimatePresence>
          {fabVisible ? (
            <motion.div
              key="ai-assistant-fab"
              className="ai-assistant-fab-motion"
              initial={fabEnter}
              animate={fabAnimate}
              exit={fabExit}
              layout={false}
            >
              <div className="ai-assistant-fab-shell">
                <button
                  type="button"
                  className="ai-assistant-fab-dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    hideFab();
                  }}
                  title="Скрыть кнопку"
                  aria-label="Скрыть кнопку ассистента"
                >
                  <span aria-hidden>×</span>
                </button>
                <button
                  type="button"
                  className="ai-assistant-fab"
                  onClick={() => setOpen((v) => !v)}
                  title="ИИ‑ассистент"
                  aria-expanded={open}
                  aria-haspopup="dialog"
                >
                  <SparklesIcon className="ai-assistant-fab-icon" />
                  <span className="ai-assistant-fab-label" aria-hidden>
                    ИИ
                  </span>
                  <span className="visually-hidden">Открыть чат с ассистентом</span>
                </button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}
