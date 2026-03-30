import { Route, Routes } from 'react-router-dom';
import { ArticlePage } from './pages/ArticlePage';
import { ArticlesPage } from './pages/ArticlesPage';
import { FeedsPage } from './pages/FeedsPage';
import { Layout } from './Layout';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<FeedsPage />} />
        <Route path="/articles" element={<ArticlesPage />} />
        <Route path="/articles/:id" element={<ArticlePage />} />
      </Route>
    </Routes>
  );
}
