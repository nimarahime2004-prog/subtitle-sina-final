import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ApiProvider,
  AppSettings,
  CueStatus,
  FileStatus,
  FolderToneRule,
  GlossaryTerm,
  OperationLog,
  Project,
  ProviderType,
  QaIssue,
  SubtitleCue,
  SubtitleFile,
  TranslationTone,
} from '../src/shared/types.ts';
import { analyzeCueQuality } from './subtitleEngine.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'subtitle_translator.db');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    default_tone TEXT NOT NULL DEFAULT 'documentary_direct',
    custom_tone_prompt TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS folder_tones (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    folder_path TEXT NOT NULL,
    tone TEXT NOT NULL,
    custom_prompt TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, folder_path)
  );

  CREATE TABLE IF NOT EXISTS subtitle_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL,
    folder_path TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL,
    format TEXT NOT NULL,
    file_header TEXT NOT NULL DEFAULT '',
    line_ending TEXT NOT NULL DEFAULT '\n',
    tone_override TEXT,
    custom_tone_override TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    active_provider_name TEXT,
    active_model_name TEXT,
    total_cues INTEGER NOT NULL DEFAULT 0,
    completed_cues INTEGER NOT NULL DEFAULT 0,
    error_cues INTEGER NOT NULL DEFAULT 0,
    incomplete_cues INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subtitle_cues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL REFERENCES subtitle_files(id) ON DELETE CASCADE,
    cue_index INTEGER NOT NULL,
    cue_identifier TEXT NOT NULL DEFAULT '',
    raw_timecode_line TEXT NOT NULL,
    start_ms INTEGER NOT NULL DEFAULT 0,
    end_ms INTEGER NOT NULL DEFAULT 0,
    source_text TEXT NOT NULL,
    translated_text TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    qa_issues_json TEXT NOT NULL DEFAULT '[]',
    provider_used TEXT,
    model_used TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_cues_file_idx ON subtitle_cues(file_id, cue_index);
  CREATE INDEX IF NOT EXISTS idx_files_project ON subtitle_files(project_id);

  CREATE TABLE IF NOT EXISTS api_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    available_models_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 10,
    rpm_limit INTEGER NOT NULL DEFAULT 10,
    tpm_limit INTEGER NOT NULL DEFAULT 120000,
    timeout_ms INTEGER NOT NULL DEFAULT 300000,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'untested',
    last_latency_ms INTEGER,
    last_error TEXT,
    total_requests INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    input_price_per_1m REAL NOT NULL DEFAULT 0.15,
    output_price_per_1m REAL NOT NULL DEFAULT 0.60,
    cooldown_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS glossary_terms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    source_term TEXT NOT NULL,
    target_term TEXT NOT NULL,
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    whole_word INTEGER NOT NULL DEFAULT 1,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL DEFAULT 'info',
    category TEXT NOT NULL DEFAULT 'queue',
    project_id INTEGER,
    file_id INTEGER,
    provider_name TEXT,
    model_name TEXT,
    message TEXT NOT NULL,
    details TEXT,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const DEFAULT_SETTINGS: AppSettings = {
  maxConcurrentFiles: 2,
  batchSize: 35,
  contextBefore: 4,
  contextAfter: 3,
  maxRetries: 4,
  adaptiveProxyTimeoutMs: 300000,
  autoRepairIncomplete: true,
  preserveHtmlTags: true,
};

function initDefaultsAndCrashRecovery(): void {
  // Crash recovery: reset any cues/files left in 'translating' after sudden exit
  db.prepare(
    `UPDATE subtitle_cues SET status = 'pending' WHERE status = 'translating'`
  ).run();
  db.prepare(
    `UPDATE subtitle_files
     SET status = CASE WHEN completed_cues > 0 THEN 'partial' ELSE 'idle' END,
         active_provider_name = NULL,
         active_model_name = NULL
     WHERE status IN ('translating', 'queued')`
  ).run();

  // Ensure default project exists with documentary_direct tone
  const projectCount = db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as {
    c: number;
  };
  if (projectCount.c === 0) {
    db.prepare(
      `INSERT INTO projects (name, description, default_tone)
       VALUES (?, ?, ?)`
    ).run(
      'پروژه اصلی زیرنویس',
      'فضای کاری پیش‌فرض برای ترجمه فایل‌ها و پوشه‌های زیرنویس SRT و VTT',
      'documentary_direct'
    );
  } else {
    // One-time upgrade of initial default project tone to documentary_direct
    const migratedTone = db
      .prepare(`SELECT value FROM app_settings WHERE key = 'migrated_default_tone_v2'`)
      .get();
    if (!migratedTone) {
      db.prepare(
        `UPDATE projects
         SET default_tone = 'documentary_direct'
         WHERE id = 1 AND default_tone = 'conversational'`
      ).run();
      db.prepare(
        `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migrated_default_tone_v2', '1')`
      ).run();
    }
  }

  // Ensure built-in server Gemini provider defaults to gemini-3.5-flash-lite with strict max 10 RPM and 300s timeout
  const builtin = db
    .prepare(`SELECT id, model_name, rpm_limit, timeout_ms FROM api_providers WHERE provider_type = 'gemini_builtin'`)
    .get() as { id: number; model_name: string; rpm_limit: number; timeout_ms: number } | undefined;
  const defaultGeminiModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-4-hydrogen',
  ];
  if (!builtin) {
    db.prepare(
      `INSERT INTO api_providers (
        name, provider_type, base_url, api_key, model_name, available_models_json,
        priority, rpm_limit, tpm_limit, timeout_ms, enabled, status,
        input_price_per_1m, output_price_per_1m
      ) VALUES (?, 'gemini_builtin', '', '', ?, ?, 1, 10, 200000, 300000, 1, 'healthy', 0.075, 0.30)`
    ).run(
      'موتور داخلی Gemini (سرور)',
      'gemini-3.5-flash-lite',
      JSON.stringify(defaultGeminiModels)
    );
  } else {
    // Apply safe defaults if still on previous starter settings
    const nextModel =
      builtin.model_name === 'gemini-4-hydrogen' || builtin.model_name === 'gemini-3.1-flash-lite'
        ? 'gemini-3.5-flash-lite'
        : builtin.model_name;
    const nextRpm = Math.min(10, Math.max(1, builtin.rpm_limit || 10));
    const nextTimeout = builtin.timeout_ms < 300000 ? 300000 : builtin.timeout_ms;
    db.prepare(
      `UPDATE api_providers
       SET model_name = ?, rpm_limit = ?, timeout_ms = ?
       WHERE id = ?`
    ).run(nextModel, nextRpm, nextTimeout, builtin.id);
  }

  // Clamp any existing Gemini provider to strict max 10 RPM so keys never get cut off
  db.prepare(
    `UPDATE api_providers
     SET rpm_limit = 10
     WHERE provider_type IN ('gemini', 'gemini_builtin') AND rpm_limit > 10`
  ).run();

  // Seed default settings
  const upsertSetting = db.prepare(
    `INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)`
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    upsertSetting.run(k, JSON.stringify(v));
  }
  // Upgrade old 180s timeout default to 300s
  db.prepare(
    `UPDATE app_settings SET value = '300000' WHERE key = 'adaptiveProxyTimeoutMs' AND value = '180000'`
  ).run();

  // One-time upgrade of default batchSize from 18 -> 35 while respecting future manual changes
  const migratedBatch = db
    .prepare(`SELECT value FROM app_settings WHERE key = 'migrated_batch_size_35'`)
    .get();
  if (!migratedBatch) {
    db.prepare(
      `UPDATE app_settings SET value = '35' WHERE key = 'batchSize' AND value = '18'`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO app_settings (key, value) VALUES ('migrated_batch_size_35', '1')`
    ).run();
  }
}

initDefaultsAndCrashRecovery();

export function maskApiKey(key: string, providerType: ProviderType): string {
  if (providerType === 'gemini_builtin') {
    return process.env.GEMINI_API_KEY ? 'پیکربندی خودکار سرور' : 'کلید سرور تنظیم نشده';
  }
  if (!key) return 'بدون کلید';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export interface ProviderRow {
  id: number;
  name: string;
  provider_type: ProviderType;
  base_url: string;
  api_key: string;
  model_name: string;
  available_models_json: string;
  priority: number;
  rpm_limit: number;
  tpm_limit: number;
  timeout_ms: number;
  enabled: number;
  status: 'untested' | 'healthy' | 'cooldown' | 'error';
  last_latency_ms: number | null;
  last_error: string | null;
  total_requests: number;
  total_tokens: number;
  input_price_per_1m: number;
  output_price_per_1m: number;
  cooldown_until: string | null;
  created_at: string;
}

export function mapProviderPublic(row: ProviderRow): ApiProvider {
  let availableModels: string[] = [];
  try {
    availableModels = JSON.parse(row.available_models_json || '[]');
  } catch {
    availableModels = [];
  }
  return {
    id: row.id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    maskedKey: maskApiKey(row.api_key, row.provider_type),
    hasKey:
      row.provider_type === 'gemini_builtin'
        ? Boolean(process.env.GEMINI_API_KEY)
        : Boolean(row.api_key),
    modelName: row.model_name,
    availableModels,
    priority: row.priority,
    rpmLimit: row.rpm_limit,
    tpmLimit: row.tpm_limit,
    timeoutMs: row.timeout_ms,
    enabled: Boolean(row.enabled),
    status: row.status,
    lastLatencyMs: row.last_latency_ms,
    lastError: row.last_error,
    totalRequests: row.total_requests,
    totalTokens: row.total_tokens,
    inputPricePer1M: row.input_price_per_1m,
    outputPricePer1M: row.output_price_per_1m,
    cooldownUntil: row.cooldown_until,
    createdAt: row.created_at,
  };
}

export function getSettings(): AppSettings {
  const rows = db.prepare(`SELECT key, value FROM app_settings`).all() as Array<{
    key: string;
    value: string;
  }>;
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      result[r.key] = JSON.parse(r.value);
    } catch {
      result[r.key] = r.value;
    }
  }
  return result as unknown as AppSettings;
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const stmt = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) {
      stmt.run(k, JSON.stringify(v));
    }
  }
  return getSettings();
}

export function addLog(entry: {
  level: 'info' | 'warn' | 'error' | 'success';
  category: OperationLog['category'];
  projectId?: number | null;
  fileId?: number | null;
  providerName?: string | null;
  modelName?: string | null;
  message: string;
  details?: string | null;
  tokensUsed?: number;
  latencyMs?: number | null;
}): void {
  db.prepare(
    `INSERT INTO operation_logs
      (level, category, project_id, file_id, provider_name, model_name, message, details, tokens_used, latency_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.level,
    entry.category,
    entry.projectId ?? null,
    entry.fileId ?? null,
    entry.providerName ?? null,
    entry.modelName ?? null,
    entry.message,
    entry.details ?? null,
    entry.tokensUsed ?? 0,
    entry.latencyMs ?? null
  );
}

export function recomputeFileStats(fileId: number): SubtitleFile | null {
  const cues = db
    .prepare(
      `SELECT id, source_text, translated_text, status, qa_issues_json, tokens_used
       FROM subtitle_cues WHERE file_id = ?`
    )
    .all(fileId) as Array<{
    id: number;
    source_text: string;
    translated_text: string;
    status: CueStatus;
    qa_issues_json: string;
    tokens_used: number;
  }>;

  let completed = 0;
  let errors = 0;
  let incomplete = 0;
  let totalTokens = 0;

  for (const c of cues) {
    totalTokens += c.tokens_used || 0;
    let issues: QaIssue[] = [];
    try {
      issues = JSON.parse(c.qa_issues_json || '[]');
    } catch {
      issues = [];
    }
    if (c.status === 'error') {
      errors += 1;
    } else if (
      (c.status === 'done' || c.status === 'edited') &&
      c.translated_text.trim().length > 0 &&
      issues.length === 0
    ) {
      completed += 1;
    } else if (c.status === 'incomplete' || issues.length > 0) {
      incomplete += 1;
    }
  }

  const total = cues.length;
  const current = db
    .prepare(`SELECT status FROM subtitle_files WHERE id = ?`)
    .get(fileId) as { status: FileStatus } | undefined;
  if (!current) return null;

  let nextStatus: FileStatus = current.status;
  if (current.status !== 'translating' && current.status !== 'queued' && current.status !== 'paused') {
    if (total > 0 && completed === total) {
      nextStatus = 'completed';
    } else if (errors > 0 && completed === 0) {
      nextStatus = 'error';
    } else if (completed > 0 || incomplete > 0 || errors > 0) {
      nextStatus = 'partial';
    } else {
      nextStatus = 'idle';
    }
  }

  db.prepare(
    `UPDATE subtitle_files
     SET total_cues = ?, completed_cues = ?, error_cues = ?, incomplete_cues = ?,
         total_tokens = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(total, completed, errors, incomplete, totalTokens, nextStatus, fileId);

  return getFileById(fileId);
}

export function mapProject(row: Record<string, unknown>): Project {
  return {
    id: Number(row.id),
    name: String(row.name),
    description: String(row.description || ''),
    defaultTone: String(row.default_tone || 'documentary_direct') as TranslationTone,
    customTonePrompt: String(row.custom_tone_prompt || ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    fileCount: row.file_count !== undefined ? Number(row.file_count) : undefined,
    totalCues: row.total_cues !== undefined ? Number(row.total_cues) : undefined,
    completedCues:
      row.completed_cues !== undefined ? Number(row.completed_cues) : undefined,
  };
}

export function mapSubtitleFile(row: Record<string, unknown>): SubtitleFile {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    relativePath: String(row.relative_path),
    folderPath: String(row.folder_path || ''),
    fileName: String(row.file_name),
    format: String(row.format) as 'srt' | 'vtt',
    fileHeader: String(row.file_header || ''),
    lineEnding: String(row.line_ending || '\n'),
    toneOverride: (row.tone_override as TranslationTone | null) ?? null,
    customToneOverride: (row.custom_tone_override as string | null) ?? null,
    status: String(row.status) as FileStatus,
    activeProviderName: (row.active_provider_name as string | null) ?? null,
    activeModelName: (row.active_model_name as string | null) ?? null,
    totalCues: Number(row.total_cues || 0),
    completedCues: Number(row.completed_cues || 0),
    errorCues: Number(row.error_cues || 0),
    incompleteCues: Number(row.incomplete_cues || 0),
    totalTokens: Number(row.total_tokens || 0),
    estimatedCostUsd: Number(row.estimated_cost_usd || 0),
    lastError: (row.last_error as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function mapSubtitleCue(row: Record<string, unknown>): SubtitleCue {
  let qaIssues: QaIssue[] = [];
  try {
    qaIssues = JSON.parse(String(row.qa_issues_json || '[]'));
  } catch {
    qaIssues = [];
  }
  return {
    id: Number(row.id),
    fileId: Number(row.file_id),
    cueIndex: Number(row.cue_index),
    cueIdentifier: String(row.cue_identifier || ''),
    rawTimecodeLine: String(row.raw_timecode_line),
    startMs: Number(row.start_ms || 0),
    endMs: Number(row.end_ms || 0),
    sourceText: String(row.source_text),
    translatedText: String(row.translated_text || ''),
    status: String(row.status) as CueStatus,
    qaIssues,
    providerUsed: (row.provider_used as string | null) ?? null,
    modelUsed: (row.model_used as string | null) ?? null,
    tokensUsed: Number(row.tokens_used || 0),
    updatedAt: String(row.updated_at),
  };
}

export function getFileById(fileId: number): SubtitleFile | null {
  const row = db
    .prepare(`SELECT * FROM subtitle_files WHERE id = ?`)
    .get(fileId) as Record<string, unknown> | undefined;
  return row ? mapSubtitleFile(row) : null;
}

export function getCuesByFileId(fileId: number): SubtitleCue[] {
  const rows = db
    .prepare(`SELECT * FROM subtitle_cues WHERE file_id = ? ORDER BY cue_index ASC`)
    .all(fileId) as Array<Record<string, unknown>>;
  return rows.map(mapSubtitleCue);
}

export function resolveEffectiveTone(fileId: number): {
  tone: TranslationTone;
  customPrompt: string;
} {
  const file = getFileById(fileId);
  if (!file) return { tone: 'documentary_direct', customPrompt: '' };

  if (file.toneOverride) {
    return {
      tone: file.toneOverride,
      customPrompt: file.customToneOverride || '',
    };
  }

  // Check folder hierarchy from deepest folder up to root
  if (file.folderPath) {
    const segments = file.folderPath.split('/').filter(Boolean);
    for (let i = segments.length; i >= 1; i--) {
      const candidate = segments.slice(0, i).join('/');
      const rule = db
        .prepare(
          `SELECT tone, custom_prompt FROM folder_tones WHERE project_id = ? AND folder_path = ?`
        )
        .get(file.projectId, candidate) as
        | { tone: TranslationTone; custom_prompt: string }
        | undefined;
      if (rule) {
        return { tone: rule.tone, customPrompt: rule.custom_prompt || '' };
      }
    }
  }

  const project = db
    .prepare(`SELECT default_tone, custom_tone_prompt FROM projects WHERE id = ?`)
    .get(file.projectId) as
    | { default_tone: TranslationTone; custom_tone_prompt: string }
    | undefined;
  return {
    tone: project?.default_tone || 'documentary_direct',
    customPrompt: project?.custom_tone_prompt || '',
  };
}

export function deleteFolderFromProject(
  projectId: number,
  folderPath: string
): { deletedFiles: number } {
  const clean = folderPath.replace(/^\/+|\/+$/g, '');
  db.exec('BEGIN');
  try {
    let info: { changes: number | bigint };
    if (clean === '') {
      // Delete root-level files (without folder)
      info = db
        .prepare(`DELETE FROM subtitle_files WHERE project_id = ? AND folder_path = ''`)
        .run(projectId);
    } else {
      info = db
        .prepare(
          `DELETE FROM subtitle_files
           WHERE project_id = ? AND (folder_path = ? OR folder_path LIKE ?)`
        )
        .run(projectId, clean, `${clean}/%`);
      db.prepare(
        `DELETE FROM folder_tones
         WHERE project_id = ? AND (folder_path = ? OR folder_path LIKE ?)`
      ).run(projectId, clean, `${clean}/%`);
    }
    db.exec('COMMIT');
    return { deletedFiles: Number(info.changes || 0) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function runQaOnFile(fileId: number): {
  file: SubtitleFile | null;
  flaggedCount: number;
} {
  const cues = getCuesByFileId(fileId);
  let flagged = 0;
  const updateStmt = db.prepare(
    `UPDATE subtitle_cues
     SET qa_issues_json = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  );

  for (const cue of cues) {
    if (!cue.translatedText.trim() && cue.status === 'pending') {
      continue;
    }
    const issues = analyzeCueQuality(cue.sourceText, cue.translatedText);
    let nextStatus: CueStatus = cue.status;
    if (issues.length > 0) {
      flagged += 1;
      if (cue.status !== 'error') {
        nextStatus = 'incomplete';
      }
    } else if (cue.translatedText.trim().length > 0 && cue.status === 'incomplete') {
      nextStatus = 'done';
    }
    updateStmt.run(JSON.stringify(issues), nextStatus, cue.id);
  }

  const file = recomputeFileStats(fileId);
  return { file, flaggedCount: flagged };
}

export function exportFullBackupJson(): Record<string, unknown> {
  const projects = db.prepare(`SELECT * FROM projects`).all();
  const folderTones = db.prepare(`SELECT * FROM folder_tones`).all();
  const files = db.prepare(`SELECT * FROM subtitle_files`).all();
  const cues = db.prepare(`SELECT * FROM subtitle_cues`).all();
  const glossary = db.prepare(`SELECT * FROM glossary_terms`).all();
  const settings = db.prepare(`SELECT * FROM app_settings`).all();
  // Export providers WITHOUT raw API keys for safety
  const providers = db
    .prepare(
      `SELECT id, name, provider_type, base_url, model_name, available_models_json,
              priority, rpm_limit, tpm_limit, timeout_ms, enabled,
              input_price_per_1m, output_price_per_1m
       FROM api_providers`
    )
    .all();

  return {
    app: 'AI Subtitle Translator',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    data: {
      projects,
      folderTones,
      files,
      cues,
      glossary,
      settings,
      providers,
    },
  };
}

export function restoreBackupJson(payload: Record<string, unknown>): {
  projectsRestored: number;
  filesRestored: number;
  cuesRestored: number;
} {
  const data = payload.data as Record<string, Array<Record<string, unknown>>> | undefined;
  if (!data || !Array.isArray(data.projects)) {
    throw new Error('فرمت فایل پشتیبان نامعتبر است.');
  }

  const projectIdMap = new Map<number, number>();
  const fileIdMap = new Map<number, number>();
  let projectsRestored = 0;
  let filesRestored = 0;
  let cuesRestored = 0;

  db.exec('BEGIN');
  try {
    for (const p of data.projects) {
      const res = db
        .prepare(
          `INSERT INTO projects (name, description, default_tone, custom_tone_prompt)
           VALUES (?, ?, ?, ?)`
        )
        .run(
          String(p.name || 'پروژه بازیابی‌شده'),
          String(p.description || ''),
          String(p.default_tone || 'conversational'),
          String(p.custom_tone_prompt || '')
        );
      projectIdMap.set(Number(p.id), Number(res.lastInsertRowid));
      projectsRestored += 1;
    }

    for (const ft of data.folderTones || []) {
      const newProjId = projectIdMap.get(Number(ft.project_id));
      if (!newProjId) continue;
      db.prepare(
        `INSERT OR REPLACE INTO folder_tones (project_id, folder_path, tone, custom_prompt)
         VALUES (?, ?, ?, ?)`
      ).run(
        newProjId,
        String(ft.folder_path || ''),
        String(ft.tone || 'conversational'),
        String(ft.custom_prompt || '')
      );
    }

    for (const f of data.files || []) {
      const newProjId = projectIdMap.get(Number(f.project_id));
      if (!newProjId) continue;
      const res = db
        .prepare(
          `INSERT INTO subtitle_files (
            project_id, relative_path, folder_path, file_name, format, file_header,
            line_ending, tone_override, custom_tone_override, status,
            total_cues, completed_cues, error_cues, incomplete_cues,
            total_tokens, estimated_cost_usd
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newProjId,
          String(f.relative_path || f.file_name || 'subtitle.srt'),
          String(f.folder_path || ''),
          String(f.file_name || 'subtitle.srt'),
          String(f.format || 'srt'),
          String(f.file_header || ''),
          String(f.line_ending || '\n'),
          (f.tone_override as string | null) ?? null,
          (f.custom_tone_override as string | null) ?? null,
          String(f.status === 'translating' ? 'partial' : f.status || 'idle'),
          Number(f.total_cues || 0),
          Number(f.completed_cues || 0),
          Number(f.error_cues || 0),
          Number(f.incomplete_cues || 0),
          Number(f.total_tokens || 0),
          Number(f.estimated_cost_usd || 0)
        );
      fileIdMap.set(Number(f.id), Number(res.lastInsertRowid));
      filesRestored += 1;
    }

    const insertCue = db.prepare(
      `INSERT INTO subtitle_cues (
        file_id, cue_index, cue_identifier, raw_timecode_line, start_ms, end_ms,
        source_text, translated_text, status, qa_issues_json,
        provider_used, model_used, tokens_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const c of data.cues || []) {
      const newFileId = fileIdMap.get(Number(c.file_id));
      if (!newFileId) continue;
      insertCue.run(
        newFileId,
        Number(c.cue_index || 0),
        String(c.cue_identifier || ''),
        String(c.raw_timecode_line || '00:00:00,000 --> 00:00:01,000'),
        Number(c.start_ms || 0),
        Number(c.end_ms || 0),
        String(c.source_text || ''),
        String(c.translated_text || ''),
        String(c.status === 'translating' ? 'pending' : c.status || 'pending'),
        String(c.qa_issues_json || '[]'),
        (c.provider_used as string | null) ?? null,
        (c.model_used as string | null) ?? null,
        Number(c.tokens_used || 0)
      );
      cuesRestored += 1;
    }

    for (const g of data.glossary || []) {
      const mappedProj = g.project_id
        ? projectIdMap.get(Number(g.project_id)) ?? null
        : null;
      db.prepare(
        `INSERT INTO glossary_terms (project_id, source_term, target_term, case_sensitive, whole_word, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        mappedProj,
        String(g.source_term || ''),
        String(g.target_term || ''),
        Number(g.case_sensitive || 0),
        Number(g.whole_word ?? 1),
        String(g.notes || '')
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  for (const newFileId of fileIdMap.values()) {
    recomputeFileStats(newFileId);
  }

  return { projectsRestored, filesRestored, cuesRestored };
}

export function getFolderTones(projectId: number): FolderToneRule[] {
  const rows = db
    .prepare(`SELECT * FROM folder_tones WHERE project_id = ?`)
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    projectId: Number(r.project_id),
    folderPath: String(r.folder_path),
    tone: String(r.tone) as TranslationTone,
    customPrompt: String(r.custom_prompt || ''),
  }));
}

export function getGlossaryForProject(projectId: number | null): GlossaryTerm[] {
  const rows =
    projectId === null
      ? (db
          .prepare(`SELECT * FROM glossary_terms ORDER BY created_at DESC`)
          .all() as Array<Record<string, unknown>>)
      : (db
          .prepare(
            `SELECT * FROM glossary_terms
             WHERE project_id IS NULL OR project_id = ?
             ORDER BY project_id DESC, id ASC`
          )
          .all(projectId) as Array<Record<string, unknown>>);

  return rows.map((r) => ({
    id: Number(r.id),
    projectId: r.project_id === null ? null : Number(r.project_id),
    sourceTerm: String(r.source_term),
    targetTerm: String(r.target_term),
    caseSensitive: Boolean(r.case_sensitive),
    wholeWord: Boolean(r.whole_word),
    notes: String(r.notes || ''),
    createdAt: String(r.created_at),
  }));
}
