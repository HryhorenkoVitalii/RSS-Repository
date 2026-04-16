/** Сообщения чата как ушли в OpenRouter (включая system). */
export type OpenRouterDebugMessage = {
  role: string;
  content: string;
};

export type OpenRouterDebugOutcome = 'success' | 'error' | 'aborted';

export type OpenRouterDebugEntry = {
  id: string;
  at: string;
  model: string;
  messages: OpenRouterDebugMessage[];
  outcome: OpenRouterDebugOutcome;
  httpStatus?: number;
  errorMessage?: string;
  /** Текст ответа ассистента из choices[0].message.content */
  assistantContent?: string;
  /** Сырой JSON ответа (усечённый) */
  rawResponseTruncated?: string;
};

const LS_KEY = 'rss_openrouter_debug_log';
export const OPENROUTER_DEBUG_LOG_EVENT = 'rss-openrouter-log-updated';

const MAX_ENTRIES = 60;
const MAX_RAW_CHARS = 20000;

export function truncateForLog(s: string, max = MAX_RAW_CHARS): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [усечено ${s.length - max} символов]`;
}

function readEntries(): OpenRouterDebugEntry[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e === 'object' && typeof (e as OpenRouterDebugEntry).id === 'string') as OpenRouterDebugEntry[];
  } catch {
    return [];
  }
}

export function getOpenRouterDebugLog(): OpenRouterDebugEntry[] {
  return readEntries();
}

export function appendOpenRouterDebugEntry(entry: OpenRouterDebugEntry): void {
  try {
    const prev = readEntries();
    const next = [entry, ...prev].slice(0, MAX_ENTRIES);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(OPENROUTER_DEBUG_LOG_EVENT));
  } catch {
    /* quota / private mode */
  }
}

export function clearOpenRouterDebugLog(): void {
  try {
    localStorage.removeItem(LS_KEY);
    window.dispatchEvent(new Event(OPENROUTER_DEBUG_LOG_EVENT));
  } catch {
    /* ignore */
  }
}

export function cloneMessagesForLog(
  messages: ReadonlyArray<{ role: string; content: string }>,
): OpenRouterDebugMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
