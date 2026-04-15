import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';

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
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
    </svg>
  );
}

type Props = {
  fabVisible: boolean;
  onFabDismiss: () => void;
};

export function AiAssistantFab({ fabVisible, onFabDismiss }: Props) {
  const [open, setOpen] = useState(false);
  const reduceMotion = useReducedMotion() === true;

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

  function hideFab() {
    setOpen(false);
    onFabDismiss();
  }

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

  const panelEnter = reduceMotion
    ? { opacity: 0 }
    : { opacity: 0, y: 10, scale: 0.995 };
  const panelAnimate = reduceMotion
    ? { opacity: 1, transition: { duration: 0.22, ease: ease } }
    : {
        opacity: 1,
        y: 0,
        scale: 1,
        transition: { duration: 0.34, ease: ease },
      };
  const panelExit = reduceMotion
    ? { opacity: 0, transition: { duration: 0.16, ease: ease } }
    : { opacity: 0, y: 4, transition: { duration: 0.24, ease: ease } };

  return (
    <>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="ai-assistant-backdrop"
            className="ai-assistant-backdrop"
            role="presentation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.16 : 0.26, ease: ease }}
            onClick={() => setOpen(false)}
          />
        ) : null}
      </AnimatePresence>

      <div className={`ai-assistant-dock${open ? ' ai-assistant-dock--open' : ''}`}>
        <AnimatePresence>
          {open ? (
            <motion.div
              key="ai-assistant-panel"
              className="ai-assistant-panel-motion"
              role="dialog"
              aria-modal="true"
              aria-labelledby="ai-assistant-title"
              initial={panelEnter}
              animate={panelAnimate}
              exit={panelExit}
              onClick={(e) => e.stopPropagation()}
            >
              <div id="ai-assistant-panel" className="ai-assistant-panel">
                <div className="ai-assistant-panel-head">
                  <h2 id="ai-assistant-title" className="ai-assistant-panel-title">
                    AI assistant
                  </h2>
                  <button
                    type="button"
                    className="btn-ghost btn-compact"
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
                <div className="ai-assistant-panel-body muted small">
                  The assistant is not connected yet. This panel is a placeholder for chat, summaries, or feed
                  hints once the backend is wired.
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

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
                  title="Hide assistant button"
                  aria-label="Hide assistant button"
                >
                  <span aria-hidden>×</span>
                </button>
                <div className="ai-assistant-fab-float">
                  <button
                    type="button"
                    className="ai-assistant-fab"
                    onClick={() => setOpen((v) => !v)}
                    title="AI assistant"
                    aria-expanded={open}
                    aria-controls="ai-assistant-panel"
                  >
                    <SparklesIcon className="ai-assistant-fab-icon" />
                    <span className="visually-hidden">Open AI assistant</span>
                  </button>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </>
  );
}
