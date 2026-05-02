import { useEffect, useRef, useState } from 'react';
import { setApiKey } from './api';
import { OpenRouterDebugLogPanel } from './OpenRouterDebugLogPanel';
import {
  DEFAULT_OPENROUTER_MODEL,
  getOpenRouterApiKey,
  getOpenRouterModel,
  setOpenRouterApiKey,
  setOpenRouterModel,
} from './openRouterPrefs';

function GearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

type SettingsMenuProps = {
  aiAssistantFabVisible: boolean;
  onAiAssistantFabVisibleChange: (visible: boolean) => void;
};

export function SettingsMenu({ aiAssistantFabVisible, onAiAssistantFabVisibleChange }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(() => localStorage.getItem('rss_api_key') ?? '');
  const [openRouterKey, setOpenRouterKey] = useState(() => getOpenRouterApiKey() ?? '');
  const [openRouterModel, setOpenRouterModelState] = useState(() => getOpenRouterModel());
  const [openRouterLogOpen, setOpenRouterLogOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (openRouterLogOpen) setOpenRouterLogOpen(false);
        else setOpen(false);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, openRouterLogOpen]);

  useEffect(() => {
    if (!open) setOpenRouterLogOpen(false);
  }, [open]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setApiKey(key.trim() || null);
      setOpenRouterApiKey(openRouterKey.trim() || null);
      const m = openRouterModel.trim();
      setOpenRouterModel(m.length > 0 ? m : null);
      window.dispatchEvent(new Event('rss-prefs-changed'));
    }, 450);
    return () => window.clearTimeout(id);
  }, [key, openRouterKey, openRouterModel]);

  return (
    <div ref={ref} className="settings-menu-wrap">
      <button
        type="button"
        className="btn-ghost btn-compact settings-menu-trigger"
        onClick={() => {
          if (!open) {
            setKey(localStorage.getItem('rss_api_key') ?? '');
            setOpenRouterKey(getOpenRouterApiKey() ?? '');
            setOpenRouterModelState(getOpenRouterModel());
          }
          setOpen((o) => !o);
        }}
        title="Settings"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="settings-menu-panel"
      >
        <GearIcon className="settings-menu-gear" />
        <span className="visually-hidden">Settings</span>
      </button>
      {open ? (
        <div
          id="settings-menu-panel"
          className="settings-dropdown"
          role="dialog"
          aria-label="Settings"
        >
          <p className="settings-dropdown-heading">API</p>
          <label className="small">
            API Key
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="leave empty if auth disabled"
              style={{ width: '100%', marginTop: 4 }}
              autoComplete="off"
            />
          </label>

          <p className="settings-dropdown-heading" style={{ marginTop: 14 }}>
            Assistant
          </p>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={aiAssistantFabVisible}
              onChange={(e) => onAiAssistantFabVisibleChange(e.target.checked)}
            />
            <span>Show assistant button</span>
          </label>

          <p className="settings-dropdown-heading" style={{ marginTop: 14 }}>
            OpenRouter
          </p>
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            Ключ и модель для чата ассистента (
            <a href="https://openrouter.ai/" target="_blank" rel="noreferrer">
              openrouter.ai
            </a>
            ). Запросы идут из браузера напрямую в OpenRouter.
          </p>
          <label className="small">
            OpenRouter API Key
            <input
              type="password"
              value={openRouterKey}
              onChange={(e) => setOpenRouterKey(e.target.value)}
              placeholder="sk-or-…"
              style={{ width: '100%', marginTop: 4 }}
              autoComplete="off"
            />
          </label>
          <label className="small" style={{ display: 'block', marginTop: 8 }}>
            Model id
            <input
              type="text"
              value={openRouterModel}
              onChange={(e) => setOpenRouterModelState(e.target.value)}
              placeholder={DEFAULT_OPENROUTER_MODEL}
              style={{ width: '100%', marginTop: 4 }}
              autoComplete="off"
            />
          </label>

          <p className="settings-dropdown-heading" style={{ marginTop: 14 }}>
            Debug
          </p>
          <button
            type="button"
            className="btn-secondary btn-compact"
            style={{ width: '100%' }}
            onClick={() => setOpenRouterLogOpen(true)}
          >
            Лог OpenRouter…
          </button>
          <p className="muted small" style={{ margin: '6px 0 0' }}>
            В панели лога — запрос и ответ по шагам: каждая роль отдельно (полный system), текст модели и сырой JSON.
            Хранится в localStorage этой вкладки.
          </p>
        </div>
      ) : null}
      <OpenRouterDebugLogPanel open={openRouterLogOpen} onClose={() => setOpenRouterLogOpen(false)} />
    </div>
  );
}
