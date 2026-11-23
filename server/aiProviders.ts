import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type { GlossaryTerm, TranslationTone } from '../src/shared/types.ts';
import { TONE_PRESETS } from '../src/shared/types.ts';
import type { ProviderRow } from './db.ts';

export interface TranslationCueInput {
  cueIndex: number;
  sourceText: string;
}

export interface TranslationBatchRequest {
  provider: ProviderRow;
  tone: TranslationTone;
  customTonePrompt: string;
  glossary: GlossaryTerm[];
  contextBefore: TranslationCueInput[];
  targets: TranslationCueInput[];
  contextAfter: TranslationCueInput[];
  preserveHtmlTags: boolean;
  adaptiveTimeoutFloorMs?: number;
  onProgressNote?: (note: string) => void;
}

export interface TranslationBatchResult {
  translations: Map<number, string>;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  modelUsed: string;
  fallbackFromModel?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  tokensUsed: number;
  modelUsed: string;
  fallbackFromModel?: string;
  sampleReply?: string;
  error?: string;
  statusCode?: number;
}

export class ProviderApiError extends Error {
  statusCode: number;
  retryable: boolean;
  isRateLimit: boolean;
  isAuthError: boolean;
  retryAfterSec?: number;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      retryable?: boolean;
      isRateLimit?: boolean;
      isAuthError?: boolean;
      retryAfterSec?: number;
    } = {}
  ) {
    super(message);
    this.name = 'ProviderApiError';
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.isRateLimit = options.isRateLimit ?? false;
    this.isAuthError = options.isAuthError ?? false;
    this.retryAfterSec = options.retryAfterSec;
  }
}

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  custom_proxy: 'https://api.openai.com/v1',
};

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const FALLBACK_GEMINI_MODEL = 'gemini-3.1-flash-lite';

const VALID_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4-hydrogen',
];

// Tracks temporary 503/UNAVAILABLE demand spikes on gemini-3.5-flash-lite (auto-recovers after 2 min)
let gemini35SpikeUntilMs = 0;

function isModelUnavailableOrOverloaded(err: ProviderApiError): boolean {
  const lower = err.message.toLowerCase();
  return (
    err.statusCode === 503 ||
    err.statusCode === 500 ||
    err.statusCode === 502 ||
    err.statusCode === 504 ||
    err.statusCode === 404 ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('not_found') ||
    lower.includes('not found')
  );
}

function shouldTryGeminiFallback(primaryModel: string): boolean {
  return primaryModel.trim().toLowerCase() !== FALLBACK_GEMINI_MODEL;
}

/**
 * Computes a generous adaptive timeout so slow relay/proxy APIs never trigger
 * premature timeouts. Scales up automatically if the provider previously took long.
 */
function computeEffectiveTimeoutMs(
  provider: ProviderRow,
  globalFloorMs = 300_000
): number {
  const configured = Math.max(provider.timeout_ms || 300_000, globalFloorMs, 180_000);
  const prevLatency = provider.last_latency_ms || 0;
  if (prevLatency > 15_000) {
    // Slow API/proxy detected: dynamically extend patience up to 15 minutes
    const adaptive = Math.min(900_000, Math.round(prevLatency * 4 + 150_000));
    return Math.max(configured, adaptive);
  }
  return Math.min(900_000, configured);
}

function getGeminiClient(provider: ProviderRow, timeoutMs: number): GoogleGenAI {
  const apiKey =
    provider.provider_type === 'gemini_builtin'
      ? process.env.GEMINI_API_KEY
      : provider.api_key;
  if (!apiKey) {
    throw new ProviderApiError(
      provider.provider_type === 'gemini_builtin'
        ? 'کلید سرور Gemini در محیط اجرا تنظیم نشده است.'
        : 'کلید API برای این ارائه‌دهنده وارد نشده است.',
      { statusCode: 401, isAuthError: true, retryable: false }
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
      timeout: timeoutMs,
    },
  });
}

function buildSystemInstruction(
  tone: TranslationTone,
  customTonePrompt: string,
  glossary: GlossaryTerm[],
  preserveHtmlTags: boolean
): string {
  const preset = TONE_PRESETS.find((t) => t.id === tone) ?? TONE_PRESETS[0];
  const toneGuide =
    tone === 'custom' && customTonePrompt.trim()
      ? customTonePrompt.trim()
      : customTonePrompt.trim()
        ? `${preset.instructionEn}\nAdditional user direction: ${customTonePrompt.trim()}`
        : preset.instructionEn;

  const glossaryBlock =
    glossary.length > 0
      ? `\nMANDATORY GLOSSARY (always apply these exact Persian equivalents when these terms appear):\n${glossary
          .map(
            (g) =>
              `- "${g.sourceTerm}" => "${g.targetTerm}"${g.notes ? ` (${g.notes})` : ''}`
          )
          .join('\n')}`
      : '';

  return [
    'You are an elite professional English-to-Persian (Farsi) subtitle translator.',
    'STRICT RULES:',
    '1. Translate ONLY the items inside `targets` into natural, idiomatic, fluent Persian subtitles.',
    '2. NEVER translate or include items from `context_before` or `context_after`; use them strictly to understand pronouns, speaker gender, tone, and sentence continuation.',
    '3. Preserve EVERY single cue index (`i`) 1-to-1. Do NOT merge, split, skip, summarize, or omit any cue or clause.',
    '4. NEVER add explanations, notes, prefixes like "ترجمه:", brackets, or commentary.',
    '5. Avoid literal word-for-word translation. Use natural Persian word order, proper half-space (ZWNJ / نیم‌فاصله like «می‌رود», «کتاب‌ها»), and clean Persian punctuation.',
    preserveHtmlTags
      ? '6. Preserve inline subtitle formatting tags (such as <i>...</i> or <b>...</b>) and meaningful line breaks (\\n) where appropriate.'
      : '6. Keep subtitle text clean without adding extra HTML tags.',
    `7. TONE & STYLE: ${toneGuide}`,
    glossaryBlock,
    '8. Return valid JSON ONLY matching {"items": [{"i": <number>, "t": "<persian translation>"}]}.',
  ]
    .filter(Boolean)
    .join('\n');
}

function filterRelevantGlossary(
  glossary: GlossaryTerm[],
  targets: TranslationCueInput[]
): GlossaryTerm[] {
  if (glossary.length === 0) return [];
  const combined = targets.map((t) => t.sourceText).join('\n');
  const combinedLower = combined.toLowerCase();
  return glossary.filter((g) => {
    if (!g.sourceTerm.trim()) return false;
    return g.caseSensitive
      ? combined.includes(g.sourceTerm)
      : combinedLower.includes(g.sourceTerm.toLowerCase());
  });
}

function buildUserPayload(req: TranslationBatchRequest): string {
  const payload = {
    context_before: req.contextBefore.map((c) => ({
      i: c.cueIndex,
      en: c.sourceText,
    })),
    targets: req.targets.map((c) => ({
      i: c.cueIndex,
      en: c.sourceText,
    })),
    context_after: req.contextAfter.map((c) => ({
      i: c.cueIndex,
      en: c.sourceText,
    })),
  };
  return JSON.stringify(payload);
}

function parseJsonTranslationOutput(
  rawText: string,
  expectedIndices: number[]
): Map<number, string> {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const candidate = objMatch?.[0] ?? arrMatch?.[0];
    if (!candidate) {
      throw new ProviderApiError('پاسخ مدل در قالب JSON معتبر نبود.', {
        statusCode: 502,
        retryable: true,
      });
    }
    parsed = JSON.parse(candidate);
  }

  const items: Array<Record<string, unknown>> = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>)?.items)
      ? ((parsed as Record<string, unknown>).items as Array<Record<string, unknown>>)
      : Array.isArray((parsed as Record<string, unknown>)?.translations)
        ? ((parsed as Record<string, unknown>).translations as Array<Record<string, unknown>>)
        : [];

  const result = new Map<number, string>();
  const expectedSet = new Set(expectedIndices);

  for (const item of items) {
    const idx = Number(item.i ?? item.index ?? item.id);
    const text = String(item.t ?? item.text ?? item.translation ?? '').trim();
    if (!Number.isNaN(idx) && expectedSet.has(idx) && text.length > 0) {
      result.set(idx, text);
    }
  }

  return result;
}

function parseRetryAfterHeader(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.min(300, Math.ceil(seconds));
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    if (diffSec > 0) return Math.min(300, diffSec);
  }
  return undefined;
}

function classifyHttpError(
  status: number,
  bodyText: string,
  retryAfterSec?: number
): ProviderApiError {
  const snippet = bodyText.slice(0, 320);
  if (status === 429) {
    return new ProviderApiError(
      `محدودیت نرخ یا سهمیه API (کد 429): ${snippet}`,
      { statusCode: 429, isRateLimit: true, retryable: true, retryAfterSec }
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderApiError(
      `خطای احراز هویت یا دسترسی کلید API (کد ${status}): ${snippet}`,
      { statusCode: status, isAuthError: true, retryable: false }
    );
  }
  if (status === 404) {
    return new ProviderApiError(
      `مدل یا آدرس API یافت نشد (کد 404): ${snippet}`,
      { statusCode: 404, retryable: false }
    );
  }
  if (status >= 500 || status === 408) {
    return new ProviderApiError(
      `تأخیر یا خطای موقت سرور / API واسط (کد ${status}): ${snippet}`,
      { statusCode: status, retryable: true }
    );
  }
  return new ProviderApiError(`خطای API (کد ${status}): ${snippet}`, {
    statusCode: status,
    retryable: false,
  });
}

function classifyGeminiError(err: unknown): ProviderApiError {
  const msg = err instanceof Error ? err.message : String(err);
  const statusMatch = msg.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  const status = statusMatch ? Number(statusMatch[1]) : 500;
  const lower = msg.toLowerCase();

  // Extract retryDelay seconds if Gemini reports e.g. "retry in 42s"
  const retryMatch = msg.match(/retry(?:\s+in|\s+after)?\s+(\d+(?:\.\d+)?)s/i);
  const retryAfterSec = retryMatch ? Math.min(300, Math.ceil(Number(retryMatch[1]))) : undefined;

  if (status === 429 || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return new ProviderApiError(`محدودیت سهمیه یا RPM در Gemini (جلوگیری از بلاک): ${msg}`, {
      statusCode: 429,
      isRateLimit: true,
      retryable: true,
      retryAfterSec: retryAfterSec ?? 65,
    });
  }
  if (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('permission_denied')
  ) {
    return new ProviderApiError(`خطای اعتبارسنجی کلید Gemini: ${msg}`, {
      statusCode: status === 500 ? 403 : status,
      isAuthError: true,
      retryable: false,
    });
  }
  if (status === 404 || lower.includes('not_found')) {
    return new ProviderApiError(`مدل درخواستی Gemini یافت نشد: ${msg}`, {
      statusCode: 404,
      retryable: false,
    });
  }
  if (lower.includes('timeout') || lower.includes('aborted') || status >= 500) {
    return new ProviderApiError(`تأخیر یا خطای موقت در پاسخ Gemini: ${msg}`, {
      statusCode: status,
      retryable: true,
    });
  }
  return new ProviderApiError(`خطای Gemini: ${msg}`, {
    statusCode: status,
    retryable: true,
  });
}

/**
 * Reads an OpenAI-compatible SSE stream while resetting an idle watchdog timer
 * on every received chunk, preventing false timeouts on slow proxy relays!
 */
async function readOpenAiSseStream(
  res: Response,
  idleTimeoutMs: number,
  onProgressNote?: (note: string) => void
): Promise<{
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  model?: string;
}> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ProviderApiError('بدنه پاسخ استریم از سرور دریافت نشد.', {
      statusCode: 502,
      retryable: true,
    });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let model: string | undefined;
  let chunkCount = 0;

  while (true) {
    const readPromise = reader.read();
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        void reader.cancel();
        reject(
          new ProviderApiError(
            `توقف بیش از ${Math.round(idleTimeoutMs / 1000)} ثانیه بدون دریافت داده از API واسط`,
            { statusCode: 408, retryable: true }
          )
        );
      }, idleTimeoutMs);
    });

    const { done, value } = await Promise.race([readPromise, timeoutPromise]);
    if (timerId) clearTimeout(timerId);
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const dataStr = trimmed.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const chunk = JSON.parse(dataStr) as Record<string, unknown>;
        if (chunk.model) model = String(chunk.model);
        const choices = chunk.choices as Array<{
          delta?: { content?: string };
          message?: { content?: string };
        }> | undefined;
        const piece = choices?.[0]?.delta?.content ?? choices?.[0]?.message?.content ?? '';
        if (piece) {
          content += piece;
          chunkCount += 1;
          if (chunkCount % 12 === 0 && onProgressNote) {
            onProgressNote(`در حال دریافت تدریجی از API واسط (${content.length} کاراکتر)...`);
          }
        }
        const usage = chunk.usage as Record<string, number> | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
          totalTokens = usage.total_tokens ?? totalTokens;
        }
      } catch {
        // Ignore keep-alive comment frames or partial JSON lines
      }
    }
  }

  return { content, inputTokens, outputTokens, totalTokens, model };
}

export async function translateBatchWithProvider(
  req: TranslationBatchRequest
): Promise<TranslationBatchResult> {
  const relevantGlossary = filterRelevantGlossary(req.glossary, req.targets);
  const systemInstruction = buildSystemInstruction(
    req.tone,
    req.customTonePrompt,
    relevantGlossary,
    req.preserveHtmlTags
  );
  const userContent = buildUserPayload(req);
  const expectedIndices = req.targets.map((t) => t.cueIndex);
  const startedAt = Date.now();
  const effectiveTimeoutMs = computeEffectiveTimeoutMs(
    req.provider,
    req.adaptiveTimeoutFloorMs
  );

  if (
    req.provider.provider_type === 'gemini_builtin' ||
    req.provider.provider_type === 'gemini'
  ) {
    const ai = getGeminiClient(req.provider, effectiveTimeoutMs);
    const configuredModel = (req.provider.model_name || DEFAULT_GEMINI_MODEL).trim();

    const invokeGemini = async (targetModel: string) => {
      const supportsThinkingLevel =
        targetModel === 'gemini-4-hydrogen' ||
        targetModel === 'gemini-4-neon' ||
        targetModel === 'gemini-4-argon' ||
        targetModel === 'gemini-4-carbon';

      const config: Record<string, unknown> = {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  i: { type: Type.INTEGER },
                  t: { type: Type.STRING },
                },
                required: ['i', 't'],
              },
            },
          },
          required: ['items'],
        },
      };

      if (supportsThinkingLevel) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      }

      const response = await ai.models.generateContent({
        model: targetModel,
        contents: userContent,
        config,
      });

      const latencyMs = Date.now() - startedAt;
      const rawText = response.text ?? '';
      const translations = parseJsonTranslationOutput(rawText, expectedIndices);
      const usage = response.usageMetadata;
      const inputTokens = usage?.promptTokenCount ?? Math.ceil(userContent.length / 4);
      const outputTokens = usage?.candidatesTokenCount ?? Math.ceil(rawText.length / 3);
      const totalTokens = usage?.totalTokenCount ?? inputTokens + outputTokens;

      return {
        translations,
        inputTokens,
        outputTokens,
        totalTokens,
        latencyMs,
        modelUsed: targetModel,
      };
    };

    // If gemini-3.5-flash-lite recently hit a 503 demand spike, use gemini-3.1-flash-lite directly during the 2-min cooldown
    const isPrimary35 = configuredModel === DEFAULT_GEMINI_MODEL;
    if (isPrimary35 && Date.now() < gemini35SpikeUntilMs) {
      req.onProgressNote?.(
        `سوئیچ موقت روی ${FALLBACK_GEMINI_MODEL} به دلیل شلوغی اخیر ${DEFAULT_GEMINI_MODEL}...`
      );
      try {
        const res = await invokeGemini(FALLBACK_GEMINI_MODEL);
        return { ...res, fallbackFromModel: configuredModel };
      } catch (err) {
        if (err instanceof ProviderApiError) throw err;
        throw classifyGeminiError(err);
      }
    }

    try {
      return await invokeGemini(configuredModel);
    } catch (err) {
      const apiErr =
        err instanceof ProviderApiError ? err : classifyGeminiError(err);

      // Automatic instant fallback from gemini-3.5-flash-lite -> gemini-3.1-flash-lite on 503 UNAVAILABLE / high demand / model failure
      if (
        shouldTryGeminiFallback(configuredModel) &&
        !apiErr.isAuthError &&
        !apiErr.isRateLimit &&
        isModelUnavailableOrOverloaded(apiErr)
      ) {
        if (isPrimary35) {
          gemini35SpikeUntilMs = Date.now() + 120_000;
        }
        req.onProgressNote?.(
          `خطای ${apiErr.statusCode} در ${configuredModel} — سوئیچ خودکار به ${FALLBACK_GEMINI_MODEL}...`
        );
        try {
          const fallbackRes = await invokeGemini(FALLBACK_GEMINI_MODEL);
          return { ...fallbackRes, fallbackFromModel: configuredModel };
        } catch (fbErr) {
          if (fbErr instanceof ProviderApiError) throw fbErr;
          throw classifyGeminiError(fbErr);
        }
      }

      throw apiErr;
    }
  }

  // OpenAI / DeepSeek / OpenRouter / Custom OpenAI-compatible slow-proxy tolerant engine
  const baseUrl = (
    req.provider.base_url ||
    DEFAULT_BASE_URLS[req.provider.provider_type] ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const modelName = req.provider.model_name || 'gpt-4o-mini';

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (req.provider.api_key) {
    headers['Authorization'] = `Bearer ${req.provider.api_key}`;
  }
  if (req.provider.provider_type === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APP_URL || 'http://localhost:3000';
    headers['X-Title'] = 'AI Subtitle Translator';
  }

  // Try streaming keep-alive first for slow proxies so idle timeout resets per chunk
  const useStreamKeepAlive =
    req.provider.provider_type === 'custom_proxy' ||
    req.provider.provider_type === 'openrouter';

  const makeRequest = async (opts: { stream: boolean; useResponseFormat: boolean }) => {
    const body: Record<string, unknown> = {
      model: modelName,
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent },
      ],
    };
    if (opts.useResponseFormat) {
      body.response_format = { type: 'json_object' };
    }
    if (opts.stream) {
      body.stream = true;
    }

    try {
      return await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(effectiveTimeoutMs),
      });
    } catch (err) {
      const isTimeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ProviderApiError(
        isTimeout
          ? `پاسخ API واسط بیش از ${Math.round(effectiveTimeoutMs / 1000)} ثانیه طول کشید (Timeout). سقف انتظار را می‌توانید تا ۹۰۰ ثانیه افزایش دهید.`
          : `خطای شبکه در اتصال به ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { statusCode: isTimeout ? 408 : 503, retryable: true }
      );
    }
  };

  let res = await makeRequest({
    stream: useStreamKeepAlive,
    useResponseFormat: true,
  });

  // Fallback if proxy rejects response_format or stream
  if (!res.ok && res.status === 400) {
    const errText = await res.text();
    const lowerErr = errText.toLowerCase();
    if (lowerErr.includes('response_format') || lowerErr.includes('stream')) {
      res = await makeRequest({ stream: false, useResponseFormat: false });
    } else {
      throw classifyHttpError(res.status, errText, parseRetryAfterHeader(res.headers));
    }
  }

  if (!res.ok) {
    const rawErr = await res.text();
    throw classifyHttpError(res.status, rawErr, parseRetryAfterHeader(res.headers));
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const streamed = await readOpenAiSseStream(
      res,
      Math.max(120_000, Math.round(effectiveTimeoutMs * 0.6)),
      req.onProgressNote
    );
    const latencyMs = Date.now() - startedAt;
    const translations = parseJsonTranslationOutput(streamed.content, expectedIndices);
    const inputTokens = streamed.inputTokens ?? Math.ceil(userContent.length / 4);
    const outputTokens = streamed.outputTokens ?? Math.ceil(streamed.content.length / 3);
    const totalTokens = streamed.totalTokens ?? inputTokens + outputTokens;
    return {
      translations,
      inputTokens,
      outputTokens,
      totalTokens,
      latencyMs,
      modelUsed: streamed.model || modelName,
    };
  }

  const rawBody = await res.text();
  const latencyMs = Date.now() - startedAt;
  const data = JSON.parse(rawBody) as Record<string, unknown>;
  const content = extractOpenAiContent(data);
  const translations = parseJsonTranslationOutput(content, expectedIndices);
  const usage = (data.usage as Record<string, number> | undefined) ?? {};
  const inputTokens = usage.prompt_tokens ?? Math.ceil(userContent.length / 4);
  const outputTokens = usage.completion_tokens ?? Math.ceil(content.length / 3);
  const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;

  return {
    translations,
    inputTokens,
    outputTokens,
    totalTokens,
    latencyMs,
    modelUsed: String(data.model || modelName),
  };
}

function extractOpenAiContent(data: Record<string, unknown>): string {
  const choices = data.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (!content) {
    throw new ProviderApiError('پاسخ مدل خالی بود.', {
      statusCode: 502,
      retryable: true,
    });
  }
  return content;
}

export async function testProviderConnection(
  provider: ProviderRow
): Promise<ProviderTestResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(provider.timeout_ms || 180_000, 120_000);
  try {
    if (
      provider.provider_type === 'gemini_builtin' ||
      provider.provider_type === 'gemini'
    ) {
      const ai = getGeminiClient(provider, timeoutMs);
      const modelName = (provider.model_name || DEFAULT_GEMINI_MODEL).trim();
      const prompt =
        'Translate to crisp, direct documentary Persian (only the translation, nothing else): "Every signal leaves a trace."';

      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: prompt,
        });
        const latencyMs = Date.now() - startedAt;
        return {
          ok: true,
          latencyMs,
          tokensUsed: response.usageMetadata?.totalTokenCount ?? 0,
          modelUsed: modelName,
          sampleReply: (response.text ?? '').trim(),
        };
      } catch (primaryErr) {
        const apiErr = classifyGeminiError(primaryErr);
        if (
          shouldTryGeminiFallback(modelName) &&
          !apiErr.isAuthError &&
          !apiErr.isRateLimit &&
          isModelUnavailableOrOverloaded(apiErr)
        ) {
          const fallbackRes = await ai.models.generateContent({
            model: FALLBACK_GEMINI_MODEL,
            contents: prompt,
          });
          const latencyMs = Date.now() - startedAt;
          return {
            ok: true,
            latencyMs,
            tokensUsed: fallbackRes.usageMetadata?.totalTokenCount ?? 0,
            modelUsed: FALLBACK_GEMINI_MODEL,
            fallbackFromModel: modelName,
            sampleReply: (fallbackRes.text ?? '').trim(),
          };
        }
        throw apiErr;
      }
    }

    const baseUrl = (
      provider.base_url ||
      DEFAULT_BASE_URLS[provider.provider_type] ||
      'https://api.openai.com/v1'
    ).replace(/\/+$/, '');
    const modelName = provider.model_name || 'gpt-4o-mini';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (provider.api_key) {
      headers['Authorization'] = `Bearer ${provider.api_key}`;
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelName,
        messages: [
          {
            role: 'user',
            content:
              'Translate to crisp, direct documentary Persian (only the translation): "Every signal leaves a trace."',
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const latencyMs = Date.now() - startedAt;
    const raw = await res.text();
    if (!res.ok) {
      const err = classifyHttpError(res.status, raw, parseRetryAfterHeader(res.headers));
      return {
        ok: false,
        latencyMs,
        tokensUsed: 0,
        modelUsed: modelName,
        error: err.message,
        statusCode: res.status,
      };
    }

    const data = JSON.parse(raw) as Record<string, unknown>;
    const reply = extractOpenAiContent(data).trim();
    const usage = (data.usage as Record<string, number> | undefined) ?? {};
    return {
      ok: true,
      latencyMs,
      tokensUsed: usage.total_tokens ?? 0,
      modelUsed: String(data.model || modelName),
      sampleReply: reply,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const apiErr =
      err instanceof ProviderApiError
        ? err
        : provider.provider_type === 'gemini' || provider.provider_type === 'gemini_builtin'
          ? classifyGeminiError(err)
          : new ProviderApiError(err instanceof Error ? err.message : String(err));
    return {
      ok: false,
      latencyMs,
      tokensUsed: 0,
      modelUsed: provider.model_name,
      error: apiErr.message,
      statusCode: apiErr.statusCode,
    };
  }
}

export async function fetchProviderModels(provider: ProviderRow): Promise<string[]> {
  if (
    provider.provider_type === 'gemini_builtin' ||
    provider.provider_type === 'gemini'
  ) {
    try {
      const ai = getGeminiClient(provider, 60_000);
      const list = await ai.models.list();
      const discovered: string[] = [];
      for await (const m of list) {
        const clean = (m.name || '').replace(/^models\//, '');
        if (
          clean &&
          !clean.includes('1.5') &&
          !clean.includes('2.0') &&
          !clean.includes('embedding') &&
          !clean.includes('tts') &&
          !clean.includes('image') &&
          !clean.includes('live') &&
          (clean.includes('gemini-4') ||
            clean.includes('gemini-3') ||
            clean.includes('gemini-2.5'))
        ) {
          discovered.push(clean);
        }
      }
      return Array.from(new Set([...VALID_GEMINI_MODELS, ...discovered]));
    } catch {
      return VALID_GEMINI_MODELS;
    }
  }

  const baseUrl = (
    provider.base_url ||
    DEFAULT_BASE_URLS[provider.provider_type] ||
    'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const headers: Record<string, string> = {};
  if (provider.api_key) {
    headers['Authorization'] = `Bearer ${provider.api_key}`;
  }

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const raw = await res.text();
    throw classifyHttpError(res.status, raw, parseRetryAfterHeader(res.headers));
  }

  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (json.data || [])
    .map((m) => m.id || '')
    .filter(Boolean)
    .sort();
  return Array.from(new Set(ids));
}
