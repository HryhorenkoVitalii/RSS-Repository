import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import {
  buildNewsAnalysisPrompt,
  describeArticleFiltersForPrompt,
} from './aiScreenDigest';
import { listAllFeeds, listArticles, listTags, type Feed, type Tag } from './api';

const PROMPT_MAX_ARTICLES = 100;

function parseCommaSepIds(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function listParamsFromArticlesUrl(search: string): {
  feedIds: string[];
  tagIds: string[];
  modifiedOnly: boolean;
  dateFrom: string;
  dateTo: string;
  q: string;
} {
  const sp = new URLSearchParams(search);
  return {
    feedIds: parseCommaSepIds(sp.get('feed_id')),
    tagIds: parseCommaSepIds(sp.get('tag_id')),
    modifiedOnly: sp.get('modified_only') === 'true',
    dateFrom: sp.get('date_from') ?? '',
    dateTo: sp.get('date_to') ?? '',
    q: sp.get('q') ?? '',
  };
}

type FilteredArticlesPromptContextValue = {
  openFilteredArticlesPrompt: () => void;
};

const FilteredArticlesPromptContext =
  createContext<FilteredArticlesPromptContextValue | null>(null);

export function useOpenFilteredArticlesPrompt(): () => void {
  const ctx = useContext(FilteredArticlesPromptContext);
  if (!ctx) {
    throw new Error('FilteredArticlesPromptProvider is missing');
  }
  return ctx.openFilteredArticlesPrompt;
}

export function FilteredArticlesPromptProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const openFilteredArticlesPrompt = useCallback(() => {
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) {
      setErr(null);
      setText('');
      setLoading(false);
      setCopied(false);
      return;
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setErr(null);
      setText('');
      try {
        const onArticlesHome = location.pathname === '/';
        const f = onArticlesHome
          ? listParamsFromArticlesUrl(location.search)
          : {
              feedIds: [] as string[],
              tagIds: [] as string[],
              modifiedOnly: false,
              dateFrom: '',
              dateTo: '',
              q: '',
            };

        const [feeds, tags, articlesRes] = await Promise.all([
          listAllFeeds().catch(() => [] as Feed[]),
          listTags().catch(() => [] as Tag[]),
          listArticles({
            feedIds: f.feedIds.length > 0 ? f.feedIds : undefined,
            tagIds: f.tagIds.length > 0 ? f.tagIds : undefined,
            modifiedOnly: f.modifiedOnly,
            page: 0,
            limit: PROMPT_MAX_ARTICLES,
            dateFrom: f.dateFrom || undefined,
            dateTo: f.dateTo || undefined,
            q: f.q.trim() || undefined,
          }),
        ]);

        if (cancelled) return;

        const feedMap = new Map<number, string>();
        for (const feed of feeds) {
          feedMap.set(feed.id, feed.title?.trim() || feed.url);
        }

        const filterBlock = describeArticleFiltersForPrompt({
          feedIds: f.feedIds,
          tagIds: f.tagIds,
          modifiedOnly: f.modifiedOnly,
          dateFrom: f.dateFrom,
          dateTo: f.dateTo,
          searchQuery: f.q,
          feeds,
          tags,
        });

        const headNote = onArticlesHome
          ? ''
          : '_(Вы не на странице «Статьи» — в промпт попали последние записи **без** фильтров из адреса; откройте `/` и задайте фильтры, затем снова откройте промпт.)_\n\n';

        const body = buildNewsAnalysisPrompt({
          articles: articlesRes.articles,
          feedTitle: (fid) => feedMap.get(fid),
          filterBlock,
          totalMatching: articlesRes.total,
          maxIncluded: PROMPT_MAX_ARTICLES,
        });

        setText(headNote + body);
      } catch (e) {
        if (!cancelled) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [open, location.pathname, location.search]);

  useEffect(() => {
    if (!open || loading) return;
    const t = window.setTimeout(() => textareaRef.current?.focus(), 80);
    return () => window.clearTimeout(t);
  }, [open, loading, text]);

  const copyText = useCallback(async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      window.prompt('Скопируйте текст вручную (Ctrl+C / ⌘C):', text);
    }
  }, [text]);

  const ctx = useMemo(
    () => ({ openFilteredArticlesPrompt }),
    [openFilteredArticlesPrompt],
  );

  const modal =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="filtered-articles-prompt-backdrop"
            role="presentation"
            onClick={() => setOpen(false)}
          >
            <div
              className="filtered-articles-prompt-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="filtered-articles-prompt-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="filtered-articles-prompt-head">
                <h2 id="filtered-articles-prompt-title" className="filtered-articles-prompt-title">
                  Промпт для ИИ
                </h2>
                <button
                  type="button"
                  className="btn-ghost btn-compact"
                  onClick={() => setOpen(false)}
                  aria-label="Закрыть"
                >
                  ✕
                </button>
              </div>
              <p className="muted small filtered-articles-prompt-hint">
                До {PROMPT_MAX_ARTICLES} последних статей по текущим фильтрам со страницы «Статьи»
                (параметры в адресе). Скопируйте текст во внешний чат.
              </p>
              {loading ? <p className="muted filtered-articles-prompt-status">Загрузка…</p> : null}
              {err ? <p className="err filtered-articles-prompt-status">{err}</p> : null}
              {!loading && !err ? (
                <textarea
                  ref={textareaRef}
                  className="filtered-articles-prompt-textarea mono"
                  readOnly
                  value={text}
                  spellCheck={false}
                  rows={22}
                />
              ) : null}
              <div className="filtered-articles-prompt-actions">
                <button
                  type="button"
                  className="btn-primary"
                  disabled={loading || Boolean(err) || !text}
                  onClick={() => void copyText()}
                >
                  {copied ? 'Скопировано' : 'Скопировать'}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                  Закрыть
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <FilteredArticlesPromptContext.Provider value={ctx}>
      {children}
      {modal}
    </FilteredArticlesPromptContext.Provider>
  );
}
