import type { Article, Feed, Tag } from './api';
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

/** Human-readable filter description for LLM prompts (Markdown list lines). */
export function describeArticleFiltersForPrompt(params: {
  feedIds: string[];
  tagIds: string[];
  modifiedOnly: boolean;
  dateFrom: string;
  dateTo: string;
  /** Raw search string as in URL (`q`). */
  searchQuery: string;
  feeds: Feed[];
  tags: Tag[];
}): string {
  const lines: string[] = [];

  if (params.feedIds.length === 0) {
    lines.push(
      '- **Ленты:** без ограничения (учитываются все ленты при прочих условиях).',
    );
  } else {
    const labels = params.feedIds.map((id) => {
      const f = params.feeds.find((x) => String(x.id) === id);
      return f ? (f.title?.trim() || f.url) : `feed id ${id}`;
    });
    lines.push(`- **Ленты (логика ИЛИ):** ${labels.join('; ')}`);
  }

  if (params.tagIds.length === 0) {
    lines.push('- **Теги:** не участвуют в отборе.');
  } else {
    const labels = params.tagIds.map((id) => {
      const t = params.tags.find((x) => String(x.id) === id);
      return t ? t.name : `tag id ${id}`;
    });
    lines.push(
      `- **Теги (ИЛИ — подходит, если у ленты статьи есть любой из тегов):** ${labels.join('; ')}`,
    );
  }

  lines.push(
    `- **Только изменённые:** ${params.modifiedOnly ? 'да (несколько версий текста)' : 'нет'}.`,
  );

  if (params.dateFrom || params.dateTo) {
    lines.push(
      `- **Дата публикации:** ${params.dateFrom || '…'} … ${params.dateTo || '…'}`,
    );
  } else {
    lines.push('- **Дата публикации:** без ограничения.');
  }

  const sq = params.searchQuery.trim();
  if (sq) {
    lines.push(
      `- **Поиск по тексту (заголовок или тело, последняя версия):** ${sq}`,
    );
  } else {
    lines.push('- **Поиск по тексту:** не задан.');
  }

  return lines.join('\n');
}

const ANALYSIS_EXCERPT = 550;

/** Full prompt: task + filters + all articles in structured form (for external LLM). */
export function buildNewsAnalysisPrompt(params: {
  articles: Article[];
  feedTitle: (feedId: number) => string | undefined;
  filterBlock: string;
  totalMatching: number;
  maxIncluded: number;
}): string {
  const { articles, feedTitle, filterBlock, totalMatching, maxIncluded } = params;

  const truncated =
    articles.length > 0 && articles.length < totalMatching;

  let inclusionNote: string;
  if (articles.length === 0) {
    inclusionNote =
      'В промпт **не попало ни одной статьи** (выборка по фильтрам пустая).';
  } else if (truncated) {
    inclusionNote = `В промпт включены **${articles.length}** записей (лимит до ${maxIncluded} для размера; в базе совпадений больше).`;
  } else {
    inclusionNote = `В промпт включены **все ${articles.length}** подходящих записей.`;
  }

  const headParts = [
    '# Задача для языковой модели',
    '',
    'Ты помогаешь пользователю RSS-агрегатора. Ниже — **выборка новостей** с явным описанием фильтров.',
    'Проанализируй материалы: основные темы и события, противоречия или пробелы, общий тон (если уместно), затем дай **3–5 тезисов «что важно»** и что имеет смысл отследить дальше.',
    'Если данных мало — так и скажи. Отвечай на **русском**, со структурой (заголовки, списки).',
    '',
    '## Условия отбора (как в интерфейсе)',
    '',
    filterBlock,
    '',
    `- Всего записей в базе по этим фильтрам: **${totalMatching}**.`,
    `- ${inclusionNote}`,
    '',
    '## Статьи для анализа',
    '',
  ];

  if (articles.length === 0) {
    return [...headParts, '_Подходящих статей нет._'].join('\n');
  }

  const chunks: string[] = [];
  articles.forEach((a, i) => {
    const feed = feedTitle(a.feed_id) ?? `feed_id=${a.feed_id}`;
    const snippet = truncatePlain(htmlToPlainText(a.body ?? ''), ANALYSIS_EXCERPT);
    chunks.push(`### ${i + 1}. internal_id=${a.id}`);
    chunks.push(`- **Источник:** ${feed}`);
    chunks.push(`- **Заголовок:** ${a.title?.trim() || '(без заголовка)'}`);
    if (a.link?.trim()) chunks.push(`- **Ссылка:** ${a.link.trim()}`);
    if (a.published_at)
      chunks.push(`- **Опубликовано (как в данных):** ${a.published_at}`);
    chunks.push(`- **Фрагмент текста (из кэша):** ${snippet || '—'}`);
    chunks.push('');
  });

  return [...headParts, ...chunks].join('\n').trim();
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
