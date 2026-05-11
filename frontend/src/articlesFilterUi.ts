/** Dispatched on `window` so Layout can open the drawer owned by ArticlesPage. */
export const OPEN_ARTICLES_FILTERS_EVENT = 'rss-open-articles-filters';

export function hasArticleListFilterParamsInSearch(sp: URLSearchParams): boolean {
  return Boolean(
    sp.get('feed_id') ||
      sp.get('tag_id') ||
      sp.get('modified_only') === 'true' ||
      sp.get('date_from') ||
      sp.get('date_to') ||
      sp.get('q')?.trim(),
  );
}

export function articleListHasAppliedFiltersFromSearch(search: string): boolean {
  return hasArticleListFilterParamsInSearch(new URLSearchParams(search));
}
