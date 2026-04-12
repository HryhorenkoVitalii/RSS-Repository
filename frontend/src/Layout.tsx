import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { setApiKey } from './api';
import { PollProvider } from './PollContext';
import { Toasts } from './Toasts';

function ApiKeyButton() {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(() => localStorage.getItem('rss_api_key') ?? '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  function save() {
    setApiKey(key.trim() || null);
    setOpen(false);
    window.location.reload();
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn-ghost btn-compact"
        onClick={() => setOpen(!open)}
        title="API Key"
      >
        🔑
      </button>
      {open && (
        <div className="api-key-dropdown">
          <label className="small">
            API Key
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="leave empty if auth disabled"
              style={{ width: '100%', marginTop: 4 }}
            />
          </label>
          <button type="button" className="btn-secondary btn-compact" onClick={save} style={{ marginTop: 8 }}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  return (
    <PollProvider>
      <header className="header">
        <h1>RSS Repository</h1>
        <nav className="header-nav">
          <NavLink className="nav-link" to="/" end>
            Feeds
          </NavLink>
          <NavLink className="nav-link" to="/articles">
            Articles
          </NavLink>
          <ApiKeyButton />
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
      <Toasts />
    </PollProvider>
  );
}
