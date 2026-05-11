import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import {
  articleListHasAppliedFiltersFromSearch,
  OPEN_ARTICLES_FILTERS_EVENT,
} from './articlesFilterUi';
import { AiHeaderPromptButton } from './AiHeaderPromptButton';
import { AiScreenContextProvider } from './aiScreenContext';
import { FilteredArticlesPromptProvider } from './FilteredArticlesPrompt';
import { getAiAssistantFabVisible, setAiAssistantFabVisible } from './aiAssistantPrefs';
import { AiAssistantFab } from './AiAssistantFab';
import { PollProvider } from './PollContext';
import { SettingsMenu } from './SettingsMenu';
import { Toasts } from './Toasts';

const FeedsPage = lazy(() =>
  import('./pages/FeedsPage').then((m) => ({ default: m.FeedsPage })),
);

function prefetchFeedsPage() {
  void import('./pages/FeedsPage');
}

/**
 * Старый экран не гаснет по opacity (остаётся 1), новый наезжает сверху с 0→1.
 * Иначе на один кадр оба слоя прозрачны — мигание фона между страницами.
 */
const pageEase = [0.4, 0, 0.2, 1] as const;

function routeVariants(reduceMotion: boolean, touchUi: boolean) {
  const instant = { duration: 0.001 };
  const fadeInMs = reduceMotion ? 0.16 : touchUi ? 0.12 : 0.28;

  if (reduceMotion) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { duration: 0.16, ease: pageEase } },
      exit: { opacity: 1, transition: instant },
    };
  }

  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: fadeInMs, ease: pageEase } },
    exit: { opacity: 1, transition: instant },
  };
}

export function Layout() {
  const [feedsOpen, setFeedsOpen] = useState(false);
  const openFeedsModal = useCallback(() => {
    prefetchFeedsPage();
    setFeedsOpen(true);
  }, []);
  const [aiAssistantFabVisible, setAiAssistantFabVisibleState] = useState(getAiAssistantFabVisible);
  const location = useLocation();
  const reduceMotion = useReducedMotion() === true;
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    setCoarsePointer(mq.matches);
    const onChange = () => setCoarsePointer(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const pageMotion = useMemo(
    () => routeVariants(reduceMotion, coarsePointer),
    [reduceMotion, coarsePointer],
  );
  const year = new Date().getFullYear();
  const articlesNavActive =
    location.pathname === '/' || location.pathname.startsWith('/articles');
  const articleListFiltersActive = useMemo(
    () =>
      location.pathname === '/' &&
      articleListHasAppliedFiltersFromSearch(location.search),
    [location.pathname, location.search],
  );
  const showArticlesFiltersNav = location.pathname === '/';

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    if (!feedsOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setFeedsOpen(false);
    }
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [feedsOpen]);

  return (
    <PollProvider>
      <AiScreenContextProvider>
      <FilteredArticlesPromptProvider>
      <div className="app-shell">
        <header className="header">
          <h1>
            <Link
              to="/"
              className="header-home-link"
              onClick={() => setFeedsOpen(false)}
            >
              <img
                src="/icons/icon.svg"
                width={28}
                height={28}
                alt=""
                className="header-logo"
                decoding="async"
              />
              <span className="header-title-text">RSS Repository</span>
            </Link>
          </h1>
          <nav className="header-nav">
            <Link
              to="/"
              className={`nav-link${articlesNavActive ? ' active' : ''}`}
              aria-current={location.pathname === '/' ? 'page' : undefined}
              onClick={() => setFeedsOpen(false)}
            >
              Articles
            </Link>
            {showArticlesFiltersNav ? (
              <button
                type="button"
                className={`nav-link nav-link--button header-nav-filters-mobile${
                  articleListFiltersActive ? ' active' : ''
                }`}
                aria-haspopup="dialog"
                title="Article list filters"
                onClick={() => {
                  setFeedsOpen(false);
                  window.dispatchEvent(new Event(OPEN_ARTICLES_FILTERS_EVENT));
                }}
              >
                Filters
              </button>
            ) : null}
            <AiHeaderPromptButton />
            <SettingsMenu
              aiAssistantFabVisible={aiAssistantFabVisible}
              onAiAssistantFabVisibleChange={(visible) => {
                setAiAssistantFabVisible(visible);
                setAiAssistantFabVisibleState(visible);
              }}
              onOpenFeeds={openFeedsModal}
            />
          </nav>
        </header>
        <main className="app-shell-main">
          <div className="page-transition-root">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={location.pathname}
                className="page-transition-surface"
                variants={pageMotion}
                initial="initial"
                animate="animate"
                exit="exit"
                layout={false}
              >
                <div className="main-content-column">
                  <Outlet />
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
        <footer className="app-footer" role="contentinfo">
          <div className="app-footer-inner">
            <p className="app-footer-line">
              <span className="app-footer-brand">RSS Repository</span>
              <span className="app-footer-sep" aria-hidden="true">
                ·
              </span>
              <span className="muted">RSS / Atom feeds and article change history</span>
            </p>
            <p className="app-footer-meta muted small">
              © {year}
            </p>
          </div>
        </footer>
      </div>
      {feedsOpen ? (
        <div
          className="feeds-modal-backdrop"
          role="presentation"
          onClick={() => setFeedsOpen(false)}
        >
          <div
            id="feeds-modal-panel"
            className="feeds-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feeds-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="feeds-modal-head">
              <h2 id="feeds-modal-title" className="feeds-modal-title">
                Feeds
              </h2>
              <button
                type="button"
                className="btn-ghost btn-compact"
                onClick={() => setFeedsOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <div className="feeds-modal-body">
              <Suspense fallback={<p className="muted">Loading…</p>}>
                <FeedsPage onNavigateToArticles={() => setFeedsOpen(false)} />
              </Suspense>
            </div>
          </div>
        </div>
      ) : null}
      <AiAssistantFab
        fabVisible={aiAssistantFabVisible}
        onFabDismiss={() => {
          setAiAssistantFabVisible(false);
          setAiAssistantFabVisibleState(false);
        }}
      />
      <Toasts />
      </FilteredArticlesPromptProvider>
      </AiScreenContextProvider>
    </PollProvider>
  );
}
