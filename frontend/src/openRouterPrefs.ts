const LS_KEY = 'rss_openrouter_api_key';
const LS_MODEL = 'rss_openrouter_model';

/** Разумный дефолт; пользователь может заменить на любой slug с openrouter.ai/models */
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini';

export function getOpenRouterApiKey(): string | null {
  const v = localStorage.getItem(LS_KEY)?.trim();
  return v && v.length > 0 ? v : null;
}

export function setOpenRouterApiKey(key: string | null): void {
  if (key && key.trim()) localStorage.setItem(LS_KEY, key.trim());
  else localStorage.removeItem(LS_KEY);
}

export function getOpenRouterModel(): string {
  const m = localStorage.getItem(LS_MODEL)?.trim();
  return m && m.length > 0 ? m : DEFAULT_OPENROUTER_MODEL;
}

export function setOpenRouterModel(model: string | null): void {
  const t = model?.trim();
  if (t) localStorage.setItem(LS_MODEL, t);
  else localStorage.removeItem(LS_MODEL);
}

export function isOpenRouterConfigured(): boolean {
  return getOpenRouterApiKey() != null;
}
