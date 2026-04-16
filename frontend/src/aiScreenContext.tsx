import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type AiScreenSectionId = 'articles' | 'feeds' | 'article_detail';

type SectionsState = Record<AiScreenSectionId, string | null>;

const emptySections: SectionsState = {
  articles: null,
  feeds: null,
  article_detail: null,
};

type AiScreenContextValue = {
  /** Склеенный текст для системного/контекстного сообщения к модели */
  combinedScreenContext: string;
  setSection: (id: AiScreenSectionId, content: string | null) => void;
};

export const AiScreenContext = createContext<AiScreenContextValue | null>(null);

export function useCombinedAiScreenContext(): string {
  return useContext(AiScreenContext)?.combinedScreenContext ?? '';
}

export function AiScreenContextProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<SectionsState>(emptySections);

  const setSection = useCallback((id: AiScreenSectionId, content: string | null) => {
    setSections((prev) => {
      if (prev[id] === content) return prev;
      return { ...prev, [id]: content };
    });
  }, []);

  const combinedScreenContext = useMemo(() => {
    const parts: string[] = [];
    if (sections.feeds) parts.push(sections.feeds);
    if (sections.articles) parts.push(sections.articles);
    if (sections.article_detail) parts.push(sections.article_detail);
    return parts.join('\n\n---\n\n');
  }, [sections]);

  const value = useMemo(
    () => ({ combinedScreenContext, setSection }),
    [combinedScreenContext, setSection],
  );

  return <AiScreenContext.Provider value={value}>{children}</AiScreenContext.Provider>;
}

/** Регистрирует фрагмент контекста экрана; при размонтировании снимает. */
export function useAiScreenSection(id: AiScreenSectionId, content: string | null) {
  const ctx = useContext(AiScreenContext);
  useEffect(() => {
    if (!ctx) return;
    ctx.setSection(id, content);
    return () => ctx.setSection(id, null);
  }, [ctx, id, content]);
}
