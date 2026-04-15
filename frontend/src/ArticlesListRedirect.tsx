import { Navigate, useLocation } from 'react-router-dom';

/** Preserves query string when moving the article list from `/articles` to `/`. */
export function ArticlesListRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/', search }} replace />;
}
