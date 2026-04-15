const STORAGE_KEY = 'rss_ai_assistant_fab_visible';

/** Whether the floating AI assistant control is shown (default: true). */
export function getAiAssistantFabVisible(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== '0';
}

export function setAiAssistantFabVisible(visible: boolean): void {
  localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
}
