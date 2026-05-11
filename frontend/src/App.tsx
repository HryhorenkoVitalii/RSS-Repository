import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { ArticlesListRedirect } from './ArticlesListRedirect';
import { Layout } from './Layout';

const ArticlesPage = lazy(() =>
  import('./pages/ArticlesPage').then((m) => ({ default: m.ArticlesPage })),
);
const ArticlePage = lazy(() =>
  import('./pages/ArticlePage').then((m) => ({ default: m.ArticlePage })),
);
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
);

function RouteFallback() {
  return (
    <div className="main-content-column">
      <p className="muted" style={{ padding: '1.5rem 0' }}>
        Loading…
      </p>
    </div>
  );
}

export function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<ArticlesPage />} />
          <Route path="/articles/:id" element={<ArticlePage />} />
          <Route path="/articles" element={<ArticlesListRedirect />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
