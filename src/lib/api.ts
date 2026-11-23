import type {
  ApiProvider,
  AppSettings,
  DashboardSummary,
  FindReplaceMatch,
  FolderToneRule,
  GlossaryTerm,
  OperationLog,
  Project,
  ProviderType,
  QueueRuntimeState,
  SubtitleCue,
  SubtitleFile,
  TranslationTone,
} from '../shared/types.ts';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    ...init,
  });
  if (!res.ok) {
    let msg = `خطای سرور (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      const txt = await res.text();
      if (txt) msg = txt.slice(0, 220);
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export const api = {
  getDashboard: () => requestJson<DashboardSummary>('/api/dashboard'),

  // Projects
  getProjects: () => requestJson<Project[]>('/api/projects'),
  createProject: (body: {
    name: string;
    description?: string;
    defaultTone?: TranslationTone;
    customTonePrompt?: string;
  }) =>
    requestJson<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProject: (
    id: number,
    body: Partial<{
      name: string;
      description: string;
      defaultTone: TranslationTone;
      customTonePrompt: string;
    }>
  ) =>
    requestJson<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteProject: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  // Folder tones
  getFolderTones: (projectId: number) =>
    requestJson<FolderToneRule[]>(`/api/projects/${projectId}/folder-tones`),
  setFolderTone: (
    projectId: number,
    body: { folderPath: string; tone: TranslationTone | null; customPrompt?: string }
  ) =>
    requestJson<FolderToneRule[]>(`/api/projects/${projectId}/folder-tones`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteFolder: (projectId: number, folderPath: string) =>
    requestJson<{ ok: boolean; deletedFiles: number }>(
      `/api/projects/${projectId}/folders`,
      {
        method: 'DELETE',
        body: JSON.stringify({ folderPath }),
      }
    ),

  // Files & Import
  getProjectFiles: (projectId: number) =>
    requestJson<SubtitleFile[]>(`/api/projects/${projectId}/files`),
  importFiles: (
    projectId: number,
    files: Array<{ relativePath: string; content: string }>
  ) =>
    requestJson<{ imported: SubtitleFile[]; count: number }>(
      `/api/projects/${projectId}/import`,
      {
        method: 'POST',
        body: JSON.stringify({ files }),
      }
    ),
  loadSampleFiles: (projectId: number) =>
    requestJson<{ imported: SubtitleFile[] }>(
      `/api/projects/${projectId}/load-sample`,
      { method: 'POST' }
    ),
  updateFile: (
    fileId: number,
    body: { toneOverride?: TranslationTone | null; customToneOverride?: string | null }
  ) =>
    requestJson<SubtitleFile>(`/api/files/${fileId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteFile: (fileId: number) =>
    requestJson<{ ok: boolean }>(`/api/files/${fileId}`, { method: 'DELETE' }),
  bulkDeleteFiles: (fileIds: number[]) =>
    requestJson<{ ok: boolean; deletedCount: number }>('/api/files/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ fileIds }),
    }),

  // Cues & QA
  getFileCues: (fileId: number) =>
    requestJson<{ file: SubtitleFile; cues: SubtitleCue[] }>(
      `/api/files/${fileId}/cues`
    ),
  saveCue: (cueId: number, translatedText: string) =>
    requestJson<{ cue: SubtitleCue; file: SubtitleFile | null }>(
      `/api/cues/${cueId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ translatedText }),
      }
    ),
  runQa: (fileId: number) =>
    requestJson<{
      file: SubtitleFile | null;
      flaggedCount: number;
      cues: SubtitleCue[];
    }>(`/api/files/${fileId}/qa`, { method: 'POST' }),
  verifyIntegrity: (fileId: number) =>
    requestJson<{
      valid: boolean;
      originalCount: number;
      exportedCount: number;
      mismatches: unknown[];
    }>(`/api/files/${fileId}/verify-integrity`),

  // Find & Replace
  previewFindReplace: (body: {
    projectId: number;
    scope: 'file' | 'folder' | 'project';
    fileId?: number;
    folderPath?: string;
    findText: string;
    replaceText: string;
    wholeWord: boolean;
    caseSensitive: boolean;
  }) =>
    requestJson<{
      matches: FindReplaceMatch[];
      totalOccurrences: number;
      affectedFiles: number;
    }>('/api/find-replace/preview', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  applyFindReplace: (body: {
    projectId: number;
    scope: 'file' | 'folder' | 'project';
    fileId?: number;
    folderPath?: string;
    findText: string;
    replaceText: string;
    wholeWord: boolean;
    caseSensitive: boolean;
  }) =>
    requestJson<{
      ok: boolean;
      totalOccurrences: number;
      updatedCues: number;
      affectedFiles: number;
    }>('/api/find-replace/apply', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Queue
  getQueueStatus: () => requestJson<QueueRuntimeState>('/api/queue/status'),
  startQueue: (body: {
    fileIds: number[];
    mode?: 'pending' | 'repair' | 'selective';
    selectedCueIds?: number[];
    preferredProviderId?: number | null;
  }) =>
    requestJson<QueueRuntimeState>('/api/queue/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pauseQueue: () =>
    requestJson<QueueRuntimeState>('/api/queue/pause', { method: 'POST' }),
  resumeQueue: () =>
    requestJson<QueueRuntimeState>('/api/queue/resume', { method: 'POST' }),
  stopQueue: () =>
    requestJson<QueueRuntimeState>('/api/queue/stop', { method: 'POST' }),

  // Export (SRT, VTT, or Both regardless of input format)
  exportSingleFileUrl: (
    fileId: number,
    format: 'srt' | 'vtt' | 'both' | 'original' = 'original',
    bilingual = false
  ) => {
    const params = new URLSearchParams();
    if (format && format !== 'original') params.set('format', format);
    if (bilingual) params.set('bilingual', '1');
    const qs = params.toString();
    return `/api/files/${fileId}/export${qs ? `?${qs}` : ''}`;
  },
  exportZip: async (
    projectId: number,
    body: {
      fileIds?: number[];
      folderPath?: string;
      bilingual?: boolean;
      exportFormat?: 'both' | 'srt' | 'vtt' | 'original';
    }
  ): Promise<void> => {
    const fmt = body.exportFormat || 'both';
    const res = await fetch(`/api/projects/${projectId}/export-zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, exportFormat: fmt }),
    });
    if (!res.ok) {
      throw new Error('خطا در تولید فایل خروجی ZIP');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `subtitles_fa_${fmt}_project_${projectId}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  // Providers
  getProviders: () => requestJson<ApiProvider[]>('/api/providers'),
  createProvider: (body: {
    name: string;
    providerType: ProviderType;
    baseUrl?: string;
    apiKey?: string;
    modelName?: string;
    priority?: number;
    rpmLimit?: number;
    tpmLimit?: number;
    timeoutMs?: number;
    inputPricePer1M?: number;
    outputPricePer1M?: number;
  }) =>
    requestJson<ApiProvider>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  bulkImportProviders: (body: {
    providerType: ProviderType;
    namePrefix?: string;
    baseUrl?: string;
    modelName?: string;
    keysText: string;
    priorityStart?: number;
    rpmLimit?: number;
    tpmLimit?: number;
    timeoutMs?: number;
  }) =>
    requestJson<{ added: ApiProvider[]; count: number; skippedDuplicates?: number }>(
      '/api/providers/bulk-import',
      {
        method: 'POST',
        body: JSON.stringify(body),
      }
    ),
  bulkImportMixedProviders: (
    items: Array<{
      name?: string;
      providerType: ProviderType;
      baseUrl?: string;
      apiKey?: string;
      modelName?: string;
      priority?: number;
      rpmLimit?: number;
      tpmLimit?: number;
      timeoutMs?: number;
    }>
  ) =>
    requestJson<{ added: ApiProvider[]; count: number }>(
      '/api/providers/bulk-import-mixed',
      {
        method: 'POST',
        body: JSON.stringify({ items }),
      }
    ),
  updateProvider: (id: number, body: Record<string, unknown>) =>
    requestJson<ApiProvider>(`/api/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteProvider: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: number) =>
    requestJson<{
      result: {
        ok: boolean;
        latencyMs: number;
        tokensUsed: number;
        modelUsed: string;
        fallbackFromModel?: string;
        sampleReply?: string;
        error?: string;
      };
      provider: ApiProvider;
    }>(`/api/providers/${id}/test`, { method: 'POST' }),
  fetchModels: (id: number) =>
    requestJson<{ models: string[]; provider: ApiProvider }>(
      `/api/providers/${id}/models`,
      { method: 'POST' }
    ),

  // Glossary
  getGlossary: (projectId: number | 'all') =>
    requestJson<GlossaryTerm[]>(`/api/glossary?projectId=${projectId}`),
  addGlossaryTerm: (body: {
    projectId: number | null;
    sourceTerm: string;
    targetTerm: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    notes?: string;
  }) =>
    requestJson<GlossaryTerm>('/api/glossary', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteGlossaryTerm: (id: number) =>
    requestJson<{ ok: boolean }>(`/api/glossary/${id}`, { method: 'DELETE' }),

  // Logs
  getLogs: (level = 'all') =>
    requestJson<OperationLog[]>(`/api/logs?level=${level}&limit=150`),
  clearLogs: () => requestJson<{ ok: boolean }>('/api/logs', { method: 'DELETE' }),

  // Settings & Backup
  getSettings: () => requestJson<AppSettings>('/api/settings'),
  saveSettings: (body: Partial<AppSettings>) =>
    requestJson<AppSettings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  restoreBackup: (payload: Record<string, unknown>) =>
    requestJson<{
      ok: boolean;
      projectsRestored: number;
      filesRestored: number;
      cuesRestored: number;
    }>('/api/backup/restore', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export async function readSelectedSubtitleFiles(
  fileList: FileList | null
): Promise<Array<{ relativePath: string; content: string }>> {
  if (!fileList || fileList.length === 0) return [];
  const results: Array<{ relativePath: string; content: string }> = [];
  for (const file of Array.from(fileList)) {
    if (!/\.(srt|vtt)$/i.test(file.name)) continue;
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      file.name;
    const content = await file.text();
    results.push({ relativePath: rel, content });
  }
  return results;
}
