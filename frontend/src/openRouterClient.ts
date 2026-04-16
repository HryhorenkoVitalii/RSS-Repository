import {
  appendOpenRouterDebugEntry,
  cloneMessagesForLog,
  truncateForLog,
} from './openRouterDebugLog';

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type OpenRouterChatRole = 'system' | 'user' | 'assistant';

export type OpenRouterChatMessage = {
  role: OpenRouterChatRole;
  content: string;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

function newLogId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'AbortError') return true;
  if (e instanceof Error && e.name === 'AbortError') return true;
  return false;
}

/**
 * Один запрос chat completions (не стриминг).
 * Ключ и модель — с openrouter.ai; в настройках приложения задаются вручную.
 */
export async function openRouterChatCompletion(params: {
  apiKey: string;
  model: string;
  messages: OpenRouterChatMessage[];
  signal?: AbortSignal;
}): Promise<string> {
  const logId = newLogId();
  const at = new Date().toISOString();
  const logMessages = cloneMessagesForLog(params.messages);
  let written = false;

  const write = (entry: Parameters<typeof appendOpenRouterDebugEntry>[0]) => {
    appendOpenRouterDebugEntry(entry);
    written = true;
  };

  const base = () => ({
    id: logId,
    at,
    model: params.model,
    messages: logMessages,
  });

  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
        'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : '',
        'X-Title': 'RSS Repository',
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
      }),
      signal: params.signal,
    });

    const text = await res.text();
    const rawTrunc = truncateForLog(text);

    if (params.signal?.aborted) {
      write({ ...base(), outcome: 'aborted', httpStatus: res.status, rawResponseTruncated: rawTrunc });
      throw new DOMException('Aborted', 'AbortError');
    }

    let data: ChatCompletionResponse | null = null;
    try {
      data = text ? (JSON.parse(text) as ChatCompletionResponse) : null;
    } catch {
      write({
        ...base(),
        outcome: 'error',
        httpStatus: res.status,
        errorMessage: 'Ответ OpenRouter не является JSON',
        rawResponseTruncated: rawTrunc,
      });
      throw new Error(text ? text.slice(0, 280) : 'Пустой ответ OpenRouter');
    }

    if (!res.ok) {
      const msg =
        (data && typeof data.error?.message === 'string' && data.error.message) ||
        (typeof (data as { message?: string })?.message === 'string' &&
          (data as { message: string }).message) ||
        `HTTP ${res.status}`;
      write({
        ...base(),
        outcome: 'error',
        httpStatus: res.status,
        errorMessage: msg,
        rawResponseTruncated: rawTrunc,
      });
      throw new Error(msg);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      write({
        ...base(),
        outcome: 'error',
        httpStatus: res.status,
        errorMessage: 'Модель вернула пустой текст',
        rawResponseTruncated: rawTrunc,
      });
      throw new Error('Модель вернула пустой текст');
    }

    const trimmed = content.trim();
    write({
      ...base(),
      outcome: 'success',
      httpStatus: res.status,
      assistantContent: trimmed,
      rawResponseTruncated: rawTrunc,
    });
    return trimmed;
  } catch (e) {
    if (!written) {
      if (isAbortError(e)) {
        write({ ...base(), outcome: 'aborted' });
      } else {
        write({
          ...base(),
          outcome: 'error',
          errorMessage: e instanceof Error ? e.message : String(e),
        });
      }
    }
    throw e;
  }
}
