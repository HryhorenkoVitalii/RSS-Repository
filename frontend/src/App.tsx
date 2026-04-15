import { Route, Routes } from 'react-router-dom';
import { ArticlesListRedirect } from './ArticlesListRedirect';
import { ArticlePage } from './pages/ArticlePage';
import { ArticleScreenshotsPage } from './pages/ArticleScreenshotsPage';
import { ArticlesPage } from './pages/ArticlesPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { Layout } from './Layout';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<ArticlesPage />} />
        <Route path="/articles/:id/screenshots" element={<ArticleScreenshotsPage />} />
        <Route path="/articles/:id" element={<ArticlePage />} />
        <Route path="/articles" element={<ArticlesListRedirect />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
