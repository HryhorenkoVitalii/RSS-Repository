import { useOpenFilteredArticlesPrompt } from './FilteredArticlesPrompt';

export function AiHeaderPromptButton() {
  const open = useOpenFilteredArticlesPrompt();
  return (
    <button
      type="button"
      className="btn-ghost btn-compact ai-header-prompt-btn"
      onClick={() => open()}
      title="Промпт по фильтрам списка статей (до 100 записей) во внешний ИИ"
    >
      Промпт для ИИ
    </button>
  );
}
