export type SubtitleFormat = 'srt' | 'vtt';

export type TranslationTone =
  | 'documentary_direct'
  | 'conversational'
  | 'formal'
  | 'scientific'
  | 'philosophical'
  | 'spiritual'
  | 'cinematic'
  | 'custom';

export interface TonePreset {
  id: TranslationTone;
  labelFa: string;
  descriptionFa: string;
  instructionEn: string;
}

export const TONE_PRESETS: TonePreset[] = [
  {
    id: 'documentary_direct',
    labelFa: 'مستند و صریح (پیش‌فرض)',
    descriptionFa: 'دقیق، شفاف، صریح و بی‌پیرایه؛ وفادار به معنای واقعی بدون تلطیف، سانسور یا حاشیه‌پردازی',
    instructionEn:
      'Use crisp, direct, unembellished documentary Persian (فارسی مستند، صریح، شفاف و بی‌پیرایه). Translate the exact meaning, tone, and bluntness faithfully without softening, euphemizing, sugarcoating, censoring, or adding flowery literary fluff. Keep sentences sharp, factual, natural, and instantly readable as professional documentary subtitles.',
  },
  {
    id: 'conversational',
    labelFa: 'محاوره‌ای طبیعی',
    descriptionFa: 'مناسب فیلم، سریال، ولاگ و گفتگوهای روزمره با فارسی زنده و روان',
    instructionEn:
      'Use natural, fluid spoken Persian (محاوره‌ای استاندارد و خوانا برای زیرنویس، مثل «می‌خوام»، «بگو»، «اینجاست»). Avoid robotic bookish phrasing while keeping text concise and effortless to read on screen.',
  },
  {
    id: 'formal',
    labelFa: 'رسمی و معیار',
    descriptionFa: 'مناسب سخنرانی، اخبار، مستندهای رسمی و دوره‌های آموزشی حرفه‌ای',
    instructionEn:
      'Use polished, authoritative standard written Persian (فارسی معیار و رسمی). Maintain clarity, elegance, and grammatical precision without sounding stiff or archaic.',
  },
  {
    id: 'scientific',
    labelFa: 'علمی و تخصصی',
    descriptionFa: 'مناسب دانشگاهی، فناوری، پزشکی و مستندهای علمی با حفظ دقت اصطلاحات',
    instructionEn:
      'Use accurate, clear academic and scientific Persian. Preserve technical precision, use established Persian scientific equivalents, and avoid oversimplifying domain terminology.',
  },
  {
    id: 'philosophical',
    labelFa: 'فلسفی و اندیشه‌ورز',
    descriptionFa: 'مناسب مباحث فلسفی، روان‌شناسی عمیق و نقدهای فکری با واژگان دقیق',
    instructionEn:
      'Use nuanced, articulate Persian suited to philosophy and intellectual discourse. Preserve conceptual distinctions, logical connectors, and rhetorical depth.',
  },
  {
    id: 'spiritual',
    labelFa: 'معنوی و عرفانی',
    descriptionFa: 'مناسب متون تأملی، عرفانی و معنوی با لحن آرام، لطیف و اصیل فارسی',
    instructionEn:
      'Use serene, dignified, and resonant Persian suited to contemplative and spiritual content. Honor poetic cadence and gentle literary elegance without verbosity.',
  },
  {
    id: 'cinematic',
    labelFa: 'سینمایی و درام',
    descriptionFa: 'مناسب فیلم‌های داستانی با حفظ بار عاطفی، ریتم دیالوگ و تعلیق',
    instructionEn:
      'Translate for professional Persian cinema subtitling: preserve emotional subtext, dramatic pacing, character voice, idioms, and tight subtitle readability.',
  },
  {
    id: 'custom',
    labelFa: 'لحن سفارشی',
    descriptionFa: 'تعریف دستورالعمل اختصاصی برای سبک ترجمه پروژه یا پوشه',
    instructionEn: 'Follow the custom tone instruction supplied by the user precisely.',
  },
];

export type CueStatus = 'pending' | 'translating' | 'done' | 'error' | 'edited' | 'incomplete';
export type FileStatus = 'idle' | 'queued' | 'translating' | 'paused' | 'completed' | 'partial' | 'error';

export type QaIssueCode =
  | 'empty'
  | 'untranslated_english'
  | 'truncated'
  | 'ai_artifact'
  | 'unbalanced_tags'
  | 'line_mismatch';

export interface QaIssue {
  code: QaIssueCode;
  messageFa: string;
}

export interface SubtitleCue {
  id: number;
  fileId: number;
  cueIndex: number;
  cueIdentifier: string;
  rawTimecodeLine: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText: string;
  status: CueStatus;
  qaIssues: QaIssue[];
  providerUsed: string | null;
  modelUsed: string | null;
  tokensUsed: number;
  updatedAt: string;
}

export interface SubtitleFile {
  id: number;
  projectId: number;
  relativePath: string;
  folderPath: string;
  fileName: string;
  format: SubtitleFormat;
  fileHeader: string;
  lineEnding: string;
  toneOverride: TranslationTone | null;
  customToneOverride: string | null;
  status: FileStatus;
  activeProviderName: string | null;
  activeModelName: string | null;
  totalCues: number;
  completedCues: number;
  errorCues: number;
  incompleteCues: number;
  totalTokens: number;
  estimatedCostUsd: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderToneRule {
  projectId: number;
  folderPath: string;
  tone: TranslationTone;
  customPrompt: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  defaultTone: TranslationTone;
  customTonePrompt: string;
  createdAt: string;
  updatedAt: string;
  fileCount?: number;
  totalCues?: number;
  completedCues?: number;
}

export type ProviderType =
  | 'gemini_builtin'
  | 'gemini'
  | 'openai'
  | 'deepseek'
  | 'openrouter'
  | 'custom_proxy';

export interface ApiProvider {
  id: number;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  maskedKey: string;
  hasKey: boolean;
  modelName: string;
  availableModels: string[];
  priority: number;
  rpmLimit: number;
  tpmLimit: number;
  timeoutMs: number;
  enabled: boolean;
  status: 'untested' | 'healthy' | 'cooldown' | 'error';
  lastLatencyMs: number | null;
  lastError: string | null;
  totalRequests: number;
  totalTokens: number;
  inputPricePer1M: number;
  outputPricePer1M: number;
  cooldownUntil: string | null;
  createdAt: string;
}

export interface GlossaryTerm {
  id: number;
  projectId: number | null;
  sourceTerm: string;
  targetTerm: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  notes: string;
  createdAt: string;
}

export interface OperationLog {
  id: number;
  level: 'info' | 'warn' | 'error' | 'success';
  category: 'queue' | 'api' | 'import' | 'export' | 'qa' | 'find_replace' | 'backup';
  projectId: number | null;
  fileId: number | null;
  providerName: string | null;
  modelName: string | null;
  message: string;
  details: string | null;
  tokensUsed: number;
  latencyMs: number | null;
  createdAt: string;
}

export interface AppSettings {
  maxConcurrentFiles: number;
  batchSize: number;
  contextBefore: number;
  contextAfter: number;
  maxRetries: number;
  adaptiveProxyTimeoutMs: number;
  autoRepairIncomplete: boolean;
  preserveHtmlTags: boolean;
}

export interface QueueRuntimeState {
  state: 'idle' | 'running' | 'paused' | 'stopping';
  activeFileIds: number[];
  queuedFileIds: number[];
  activeWorkers: Array<{
    fileId: number;
    fileName: string;
    providerName: string;
    modelName: string;
    batchProgress: string;
    requestStartedAtMs?: number;
    waitingNote?: string;
  }>;
  totalProcessedInSession: number;
  startedAt: string | null;
}

export interface FindReplaceMatch {
  cueId: number;
  fileId: number;
  fileName: string;
  relativePath: string;
  cueIndex: number;
  rawTimecodeLine: string;
  beforeText: string;
  afterText: string;
  matchCount: number;
}

export interface DashboardSummary {
  totalProjects: number;
  totalFiles: number;
  totalCues: number;
  completedCues: number;
  incompleteCues: number;
  errorCues: number;
  activeProviders: number;
  totalTokens: number;
  estimatedCostUsd: number;
  avgLatencyMs: number;
  queue: QueueRuntimeState;
}
