import type { Article, Feed } from './api';
import { htmlToPlainText } from './versionDiff';

const ARTICLE_EXCERPT = 450;

function truncatePlain(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export function formatArticlesListForAi(params: {
  articles: Article[];
  feedTitle: (feedId: number) => string | undefined;
  filterSummary: string;
  page: number;
  limit: number;
  total: number;
}): string {
  const head = [
    '### Статьи на экране (текущая страница списка)',
    params.filterSummary,
    `Показано ${params.articles.length} записей на странице; всего в выборке: ${params.total} (страница ${params.page + 1}, до ${params.limit} на странице).`,
    '',
  ];

  if (params.articles.length === 0) {
    return [...head, 'По текущим фильтрам статей нет.'].join('\n');
  }

  const lines: string[] = [...head];
  params.articles.forEach((a, i) => {
    const feed = params.feedTitle(a.feed_id) ?? `feed_id=${a.feed_id}`;
    const snippet = truncatePlain(htmlToPlainText(a.body ?? ''), ARTICLE_EXCERPT);
    lines.push(`${i + 1}. [${feed}] ${a.title?.trim() || '(без заголовка)'}`);
    if (a.link?.trim()) lines.push(`   URL: ${a.link.trim()}`);
    if (a.published_at) lines.push(`   Опубликовано: ${a.published_at}`);
    if (snippet) lines.push(`   Фрагмент: ${snippet}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

export function formatFeedsPageForAi(params: {
  feeds: Feed[];
  page: number;
  limit: number;
  total: number;
}): string {
  const head = [
    '### Ленты RSS на экране (окно Feeds, текущая страница)',
    `Показано ${params.feeds.length} лент; всего: ${params.total} (страница ${params.page + 1}).`,
    '',
  ];
  if (params.feeds.length === 0) {
    return [...head, 'Список пуст.'].join('\n');
  }
  const lines: string[] = [...head];
  params.feeds.forEach((f, i) => {
    const title = f.title?.trim() || '(без названия)';
    lines.push(`${i + 1}. ${title}`);
    lines.push(`   URL: ${f.url}`);
    lines.push(`   id: ${f.id}, интервал опроса: ${f.poll_interval_seconds}s`);
    const tagBits = (f.tags ?? [])
      .map((t) => {
        const n = t.name.trim();
        if (!n) return '';
        return `${n} (${t.color})`;
      })
      .filter(Boolean);
    if (tagBits.length > 0) lines.push(`   Теги: ${tagBits.join(', ')}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

export function formatArticleDetailForAi(article: Article, feedTitle?: string): string {
  const bodyPlain = truncatePlain(htmlToPlainText(article.body ?? ''), 12000);
  const lines = [
    '### Открытая статья',
    `Лента: ${feedTitle ?? `feed_id=${article.feed_id}`}`,
    `Заголовок: ${article.title?.trim() || '(без заголовка)'}`,
  ];
  if (article.link?.trim()) lines.push(`Ссылка: ${article.link.trim()}`);
  if (article.published_at) lines.push(`Опубликовано: ${article.published_at}`);
  lines.push('', 'Текст (из кэша приложения):', bodyPlain);
  return lines.join('\n');
}
