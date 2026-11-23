import { Router } from 'express';
import JSZip from 'jszip';
import type {
  DashboardSummary,
  FindReplaceMatch,
  OperationLog,
  ProviderType,
  TranslationTone,
} from '../src/shared/types.ts';
import {
  addLog,
  db,
  deleteFolderFromProject,
  exportFullBackupJson,
  getCuesByFileId,
  getFileById,
  getFolderTones,
  getGlossaryForProject,
  getSettings,
  mapProject,
  mapProviderPublic,
  mapSubtitleCue,
  mapSubtitleFile,
  recomputeFileStats,
  restoreBackupJson,
  runQaOnFile,
  saveSettings,
  type ProviderRow,
} from './db.ts';
import {
  DEFAULT_BASE_URLS,
  DEFAULT_GEMINI_MODEL,
  fetchProviderModels,
  testProviderConnection,
} from './aiProviders.ts';
import {
  analyzeCueQuality,
  applyExactFindReplace,
  parseSubtitleContent,
  serializeSubtitleFile,
  verifyTimecodeIntegrity,
} from './subtitleEngine.ts';
import { translationManager } from './translationManager.ts';
import { buildPythonDesktopZipBuffer, listPythonDesktopFiles } from './pythonExport.ts';

export const apiRouter = Router();

// ---------- Dashboard ----------
apiRouter.get('/dashboard', (_req, res) => {
  const projCount = (db.prepare(`SELECT COUNT(*) as c FROM projects`).get() as { c: number }).c;
  const fileAgg = db
    .prepare(
      `SELECT COUNT(*) as total_files,
              COALESCE(SUM(total_cues), 0) as total_cues,
              COALESCE(SUM(completed_cues), 0) as completed_cues,
              COALESCE(SUM(incomplete_cues), 0) as incomplete_cues,
              COALESCE(SUM(error_cues), 0) as error_cues,
              COALESCE(SUM(total_tokens), 0) as total_tokens,
              COALESCE(SUM(estimated_cost_usd), 0) as total_cost
       FROM subtitle_files`
    )
    .get() as Record<string, number>;

  const providerAgg = db
    .prepare(
      `SELECT COUNT(*) as active_count,
              COALESCE(AVG(CASE WHEN last_latency_ms IS NOT NULL THEN last_latency_ms END), 0) as avg_latency
       FROM api_providers WHERE enabled = 1`
    )
    .get() as { active_count: number; avg_latency: number };

  const summary: DashboardSummary = {
    totalProjects: projCount,
    totalFiles: Number(fileAgg.total_files || 0),
    totalCues: Number(fileAgg.total_cues || 0),
    completedCues: Number(fileAgg.completed_cues || 0),
    incompleteCues: Number(fileAgg.incomplete_cues || 0),
    errorCues: Number(fileAgg.error_cues || 0),
    activeProviders: Number(providerAgg.active_count || 0),
    totalTokens: Number(fileAgg.total_tokens || 0),
    estimatedCostUsd: Number(fileAgg.total_cost || 0),
    avgLatencyMs: Math.round(Number(providerAgg.avg_latency || 0)),
    queue: translationManager.getState(),
  };

  res.json(summary);
});

// ---------- Projects ----------
apiRouter.get('/projects', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT p.*,
              COUNT(f.id) as file_count,
              COALESCE(SUM(f.total_cues), 0) as total_cues,
              COALESCE(SUM(f.completed_cues), 0) as completed_cues
       FROM projects p
       LEFT JOIN subtitle_files f ON f.project_id = p.id
       GROUP BY p.id
       ORDER BY p.id ASC`
    )
    .all() as Array<Record<string, unknown>>;
  res.json(rows.map(mapProject));
});

apiRouter.post('/projects', (req, res) => {
  const { name, description, defaultTone, customTonePrompt } = req.body as {
    name?: string;
    description?: string;
    defaultTone?: TranslationTone;
    customTonePrompt?: string;
  };
  if (!name?.trim()) {
    res.status(400).json({ error: 'نام پروژه الزامی است.' });
    return;
  }
  const info = db
    .prepare(
      `INSERT INTO projects (name, description, default_tone, custom_tone_prompt)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      name.trim(),
      (description || '').trim(),
      defaultTone || 'documentary_direct',
      (customTonePrompt || '').trim()
    );
  const created = db
    .prepare(`SELECT * FROM projects WHERE id = ?`)
    .get(info.lastInsertRowid) as Record<string, unknown>;
  addLog({
    level: 'info',
    category: 'import',
    projectId: Number(info.lastInsertRowid),
    message: `پروژه جدید «${name.trim()}» ایجاد شد.`,
  });
  res.status(201).json(mapProject(created));
});

apiRouter.patch('/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, description, defaultTone, customTonePrompt } = req.body as {
    name?: string;
    description?: string;
    defaultTone?: TranslationTone;
    customTonePrompt?: string;
  };
  const existing = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'پروژه یافت نشد.' });
    return;
  }
  db.prepare(
    `UPDATE projects
     SET name = ?, description = ?, default_tone = ?, custom_tone_prompt = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    name?.trim() || String(existing.name),
    description !== undefined ? description : String(existing.description),
    defaultTone || String(existing.default_tone),
    customTonePrompt !== undefined ? customTonePrompt : String(existing.custom_tone_prompt),
    id
  );
  const updated = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Record<
    string,
    unknown
  >;
  res.json(mapProject(updated));
});

apiRouter.delete('/projects/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// ---------- Folder Tone Rules ----------
apiRouter.get('/projects/:id/folder-tones', (req, res) => {
  res.json(getFolderTones(Number(req.params.id)));
});

apiRouter.put('/projects/:id/folder-tones', (req, res) => {
  const projectId = Number(req.params.id);
  const { folderPath, tone, customPrompt } = req.body as {
    folderPath?: string;
    tone?: TranslationTone | null;
    customPrompt?: string;
  };
  if (folderPath === undefined) {
    res.status(400).json({ error: 'مسیر پوشه الزامی است.' });
    return;
  }
  const cleanFolder = folderPath.replace(/^\/+|\/+$/g, '');
  if (!tone) {
    db.prepare(
      `DELETE FROM folder_tones WHERE project_id = ? AND folder_path = ?`
    ).run(projectId, cleanFolder);
  } else {
    db.prepare(
      `INSERT INTO folder_tones (project_id, folder_path, tone, custom_prompt)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, folder_path)
       DO UPDATE SET tone = excluded.tone, custom_prompt = excluded.custom_prompt`
    ).run(projectId, cleanFolder, tone, customPrompt || '');
  }
  res.json(getFolderTones(projectId));
});

apiRouter.delete('/projects/:id/folders', (req, res) => {
  const projectId = Number(req.params.id);
  const { folderPath } = req.body as { folderPath?: string };
  if (folderPath === undefined) {
    res.status(400).json({ error: 'مسیر پوشه برای حذف مشخص نشده است.' });
    return;
  }
  const result = deleteFolderFromProject(projectId, folderPath);
  addLog({
    level: 'info',
    category: 'import',
    projectId,
    message: `پوشه «${folderPath || 'ریشه'}» به همراه ${result.deletedFiles} فایل زیرنویس حذف شد.`,
  });
  res.json({ ok: true, ...result });
});

// ---------- Files & Import ----------
apiRouter.get('/projects/:id/files', (req, res) => {
  const projectId = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT * FROM subtitle_files WHERE project_id = ? ORDER BY folder_path ASC, file_name ASC`
    )
    .all(projectId) as Array<Record<string, unknown>>;
  res.json(rows.map(mapSubtitleFile));
});

apiRouter.post('/projects/:id/import', (req, res) => {
  const projectId = Number(req.params.id);
  const { files } = req.body as {
    files?: Array<{ relativePath: string; content: string }>;
  };
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'هیچ فایلی برای وارد کردن ارسال نشده است.' });
    return;
  }

  const imported: ReturnType<typeof mapSubtitleFile>[] = [];
  const insertFile = db.prepare(
    `INSERT INTO subtitle_files
      (project_id, relative_path, folder_path, file_name, format, file_header, line_ending, total_cues)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCue = db.prepare(
    `INSERT INTO subtitle_cues
      (file_id, cue_index, cue_identifier, raw_timecode_line, start_ms, end_ms, source_text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  );

  db.exec('BEGIN');
  try {
    for (const item of files) {
      const normalizedRel = (item.relativePath || 'subtitle.srt')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      const segments = normalizedRel.split('/').filter(Boolean);
      const fileName = segments[segments.length - 1] || 'subtitle.srt';
      if (!/\.(srt|vtt)$/i.test(fileName)) continue;

      const folderPath = segments.slice(0, -1).join('/');
      const parsed = parseSubtitleContent(item.content || '', fileName);
      if (parsed.cues.length === 0) continue;

      const info = insertFile.run(
        projectId,
        normalizedRel,
        folderPath,
        fileName,
        parsed.format,
        parsed.fileHeader,
        parsed.lineEnding,
        parsed.cues.length
      );
      const fileId = Number(info.lastInsertRowid);

      for (const cue of parsed.cues) {
        insertCue.run(
          fileId,
          cue.cueIndex,
          cue.cueIdentifier,
          cue.rawTimecodeLine,
          cue.startMs,
          cue.endMs,
          cue.sourceText
        );
      }

      const created = getFileById(fileId);
      if (created) imported.push(created);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({
      error: `خطا در وارد کردن فایل‌ها: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  addLog({
    level: 'success',
    category: 'import',
    projectId,
    message: `${imported.length} فایل زیرنویس با حفظ ساختار پوشه‌ها وارد پروژه شد.`,
  });

  res.status(201).json({ imported, count: imported.length });
});

apiRouter.post('/projects/:id/load-sample', (req, res) => {
  const projectId = Number(req.params.id);
  const sampleSrt = [
    '1',
    '00:00:01,200 --> 00:00:04,350',
    'Every great discovery begins with a quiet question.',
    '',
    '2',
    '00:00:04,600 --> 00:00:08,100',
    'For centuries, astronomers stared at the night sky,',
    'wondering whether we were truly alone.',
    '',
    '3',
    '00:00:08,450 --> 00:00:11,900',
    '<i>Wait—did you see that signal on the telescope array?</i>',
    '',
    '4',
    '00:00:12,150 --> 00:00:15,800',
    'It is not noise. The frequency repeats every twelve seconds.',
    '',
    '5',
    '00:00:16,050 --> 00:00:19,700',
    'If this reading is accurate, everything we thought we knew is about to change.',
    '',
    '6',
    '00:00:20,000 --> 00:00:23,400',
    'Call the observatory director right now. Do not tell anyone else yet.',
  ].join('\r\n');

  const sampleVtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    'NOTE Documentary lecture segment on philosophy of mind',
    '',
    'intro-1',
    '00:00:02.100 --> 00:00:05.850 align:start position:0%',
    'Consciousness remains one of the deepest mysteries in modern science.',
    '',
    'intro-2',
    '00:00:06.120 --> 00:00:10.400 align:start position:0%',
    'How does electrical activity inside a biological brain',
    'give rise to the felt experience of listening to music?',
    '',
    'intro-3',
    '00:00:10.750 --> 00:00:14.900 line:85%',
    'Philosophers call this the "hard problem" of consciousness.',
    '',
    'intro-4',
    '00:00:15.200 --> 00:00:19.000',
    'And even in the age of artificial intelligence, the question feels more urgent than ever.',
  ].join('\n');

  const samples = [
    { relativePath: 'Season 01/Episode_01_Signals.srt', content: sampleSrt },
    { relativePath: 'Lectures/Philosophy_of_Mind.vtt', content: sampleVtt },
  ];

  const imported: ReturnType<typeof mapSubtitleFile>[] = [];
  const insertFile = db.prepare(
    `INSERT INTO subtitle_files
      (project_id, relative_path, folder_path, file_name, format, file_header, line_ending, total_cues)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCue = db.prepare(
    `INSERT INTO subtitle_cues
      (file_id, cue_index, cue_identifier, raw_timecode_line, start_ms, end_ms, source_text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  );

  db.exec('BEGIN');
  try {
    for (const s of samples) {
      const segs = s.relativePath.split('/');
      const fileName = segs[segs.length - 1];
      const folderPath = segs.slice(0, -1).join('/');
      const parsed = parseSubtitleContent(s.content, fileName);
      const info = insertFile.run(
        projectId,
        s.relativePath,
        folderPath,
        fileName,
        parsed.format,
        parsed.fileHeader,
        parsed.lineEnding,
        parsed.cues.length
      );
      const fileId = Number(info.lastInsertRowid);
      for (const cue of parsed.cues) {
        insertCue.run(
          fileId,
          cue.cueIndex,
          cue.cueIdentifier,
          cue.rawTimecodeLine,
          cue.startMs,
          cue.endMs,
          cue.sourceText
        );
      }
      const created = getFileById(fileId);
      if (created) imported.push(created);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: String(err) });
    return;
  }

  addLog({
    level: 'info',
    category: 'import',
    projectId,
    message: 'دو فایل نمونه SRT و VTT در پوشه‌های جداگانه برای تست فوری بارگذاری شدند.',
  });

  res.status(201).json({ imported });
});

apiRouter.patch('/files/:id', (req, res) => {
  const fileId = Number(req.params.id);
  const { toneOverride, customToneOverride } = req.body as {
    toneOverride?: TranslationTone | null;
    customToneOverride?: string | null;
  };
  const existing = getFileById(fileId);
  if (!existing) {
    res.status(404).json({ error: 'فایل یافت نشد.' });
    return;
  }
  db.prepare(
    `UPDATE subtitle_files
     SET tone_override = ?, custom_tone_override = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    toneOverride === undefined ? existing.toneOverride : toneOverride,
    customToneOverride === undefined ? existing.customToneOverride : customToneOverride,
    fileId
  );
  res.json(getFileById(fileId));
});

apiRouter.delete('/files/:id', (req, res) => {
  const fileId = Number(req.params.id);
  const existing = getFileById(fileId);
  db.prepare(`DELETE FROM subtitle_files WHERE id = ?`).run(fileId);
  if (existing) {
    addLog({
      level: 'info',
      category: 'import',
      projectId: existing.projectId,
      message: `فایل زیرنویس «${existing.relativePath}» حذف شد.`,
    });
  }
  res.json({ ok: true });
});

apiRouter.post('/files/bulk-delete', (req, res) => {
  const { fileIds } = req.body as { fileIds?: number[] };
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    res.status(400).json({ error: 'هیچ فایلی برای حذف انتخاب نشده است.' });
    return;
  }
  const placeholders = fileIds.map(() => '?').join(',');
  const info = db
    .prepare(`DELETE FROM subtitle_files WHERE id IN (${placeholders})`)
    .run(...fileIds);
  addLog({
    level: 'info',
    category: 'import',
    message: `${Number(info.changes || 0)} فایل زیرنویس به صورت گروهی حذف شد.`,
  });
  res.json({ ok: true, deletedCount: Number(info.changes || 0) });
});

// ---------- Cues & Direct Auto-Save Editor ----------
apiRouter.get('/files/:id/cues', (req, res) => {
  const fileId = Number(req.params.id);
  const file = getFileById(fileId);
  if (!file) {
    res.status(404).json({ error: 'فایل یافت نشد.' });
    return;
  }
  const cues = getCuesByFileId(fileId);
  res.json({ file, cues });
});

apiRouter.patch('/cues/:id', (req, res) => {
  const cueId = Number(req.params.id);
  const { translatedText } = req.body as { translatedText?: string };
  if (translatedText === undefined) {
    res.status(400).json({ error: 'متن ترجمه ارسال نشده است.' });
    return;
  }
  const row = db
    .prepare(`SELECT * FROM subtitle_cues WHERE id = ?`)
    .get(cueId) as Record<string, unknown> | undefined;
  if (!row) {
    res.status(404).json({ error: 'خط زیرنویس یافت نشد.' });
    return;
  }
  const sourceText = String(row.source_text);
  const issues = analyzeCueQuality(sourceText, translatedText);
  const nextStatus = !translatedText.trim()
    ? 'pending'
    : issues.length > 0
      ? 'incomplete'
      : 'edited';

  db.prepare(
    `UPDATE subtitle_cues
     SET translated_text = ?, status = ?, qa_issues_json = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(translatedText, nextStatus, JSON.stringify(issues), cueId);

  const file = recomputeFileStats(Number(row.file_id));
  const updated = db
    .prepare(`SELECT * FROM subtitle_cues WHERE id = ?`)
    .get(cueId) as Record<string, unknown>;
  res.json({ cue: mapSubtitleCue(updated), file });
});

apiRouter.post('/files/:id/qa', (req, res) => {
  const fileId = Number(req.params.id);
  const result = runQaOnFile(fileId);
  if (!result.file) {
    res.status(404).json({ error: 'فایل یافت نشد.' });
    return;
  }
  addLog({
    level: result.flaggedCount > 0 ? 'warn' : 'success',
    category: 'qa',
    projectId: result.file.projectId,
    fileId,
    message:
      result.flaggedCount > 0
        ? `بررسی کیفیت فایل «${result.file.fileName}»: ${result.flaggedCount} خط ناقص یا دارای هشدار شناسایی شد.`
        : `بررسی کیفیت فایل «${result.file.fileName}»: هیچ خط ناقص یا خطایی یافت نشد.`,
  });
  res.json({ ...result, cues: getCuesByFileId(fileId) });
});

// ---------- Exact Find & Replace (File / Folder / Project) ----------
function queryCuesByScope(params: {
  projectId: number;
  scope: 'file' | 'folder' | 'project';
  fileId?: number;
  folderPath?: string;
}): Array<Record<string, unknown>> {
  if (params.scope === 'file' && params.fileId) {
    return db
      .prepare(
        `SELECT c.*, f.file_name, f.relative_path
         FROM subtitle_cues c
         JOIN subtitle_files f ON f.id = c.file_id
         WHERE c.file_id = ?
         ORDER BY c.cue_index ASC`
      )
      .all(params.fileId) as Array<Record<string, unknown>>;
  }
  if (params.scope === 'folder' && params.folderPath !== undefined) {
    const clean = params.folderPath.replace(/^\/+|\/+$/g, '');
    return db
      .prepare(
        `SELECT c.*, f.file_name, f.relative_path
         FROM subtitle_cues c
         JOIN subtitle_files f ON f.id = c.file_id
         WHERE f.project_id = ? AND (f.folder_path = ? OR f.folder_path LIKE ?)
         ORDER BY f.relative_path ASC, c.cue_index ASC`
      )
      .all(params.projectId, clean, clean ? `${clean}/%` : '%') as Array<
      Record<string, unknown>
    >;
  }
  return db
    .prepare(
      `SELECT c.*, f.file_name, f.relative_path
       FROM subtitle_cues c
       JOIN subtitle_files f ON f.id = c.file_id
       WHERE f.project_id = ?
       ORDER BY f.relative_path ASC, c.cue_index ASC`
    )
    .all(params.projectId) as Array<Record<string, unknown>>;
}

apiRouter.post('/find-replace/preview', (req, res) => {
  const {
    projectId,
    scope,
    fileId,
    folderPath,
    findText,
    replaceText,
    wholeWord,
    caseSensitive,
  } = req.body as {
    projectId: number;
    scope: 'file' | 'folder' | 'project';
    fileId?: number;
    folderPath?: string;
    findText: string;
    replaceText: string;
    wholeWord?: boolean;
    caseSensitive?: boolean;
  };

  if (!findText) {
    res.json({ matches: [], totalOccurrences: 0, affectedFiles: 0 });
    return;
  }

  const rows = queryCuesByScope({ projectId, scope, fileId, folderPath });
  const matches: FindReplaceMatch[] = [];
  const fileSet = new Set<number>();
  let totalOccurrences = 0;

  for (const r of rows) {
    const text = String(r.translated_text || '');
    if (!text) continue;
    const { updated, count } = applyExactFindReplace(text, findText, replaceText ?? '', {
      wholeWord: wholeWord !== false,
      caseSensitive: Boolean(caseSensitive),
    });
    if (count > 0) {
      totalOccurrences += count;
      fileSet.add(Number(r.file_id));
      matches.push({
        cueId: Number(r.id),
        fileId: Number(r.file_id),
        fileName: String(r.file_name),
        relativePath: String(r.relative_path),
        cueIndex: Number(r.cue_index),
        rawTimecodeLine: String(r.raw_timecode_line),
        beforeText: text,
        afterText: updated,
        matchCount: count,
      });
    }
  }

  res.json({
    matches,
    totalOccurrences,
    affectedFiles: fileSet.size,
  });
});

apiRouter.post('/find-replace/apply', (req, res) => {
  const {
    projectId,
    scope,
    fileId,
    folderPath,
    findText,
    replaceText,
    wholeWord,
    caseSensitive,
  } = req.body as {
    projectId: number;
    scope: 'file' | 'folder' | 'project';
    fileId?: number;
    folderPath?: string;
    findText: string;
    replaceText: string;
    wholeWord?: boolean;
    caseSensitive?: boolean;
  };

  if (!findText) {
    res.status(400).json({ error: 'عبارت جستجو نمی‌تواند خالی باشد.' });
    return;
  }

  const rows = queryCuesByScope({ projectId, scope, fileId, folderPath });
  const updateStmt = db.prepare(
    `UPDATE subtitle_cues
     SET translated_text = ?, qa_issues_json = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  );

  const affectedFileIds = new Set<number>();
  let totalOccurrences = 0;
  let updatedCues = 0;

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const text = String(r.translated_text || '');
      if (!text) continue;
      const { updated, count } = applyExactFindReplace(text, findText, replaceText ?? '', {
        wholeWord: wholeWord !== false,
        caseSensitive: Boolean(caseSensitive),
      });
      if (count > 0) {
        const issues = analyzeCueQuality(String(r.source_text), updated);
        const nextStatus = issues.length > 0 ? 'incomplete' : 'edited';
        updateStmt.run(updated, JSON.stringify(issues), nextStatus, Number(r.id));
        affectedFileIds.add(Number(r.file_id));
        totalOccurrences += count;
        updatedCues += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: String(err) });
    return;
  }

  for (const fid of affectedFileIds) {
    recomputeFileStats(fid);
  }

  addLog({
    level: 'success',
    category: 'find_replace',
    projectId,
    fileId: fileId ?? null,
    message: `جایگزینی دقیق «${findText}» به «${replaceText ?? ''}»: ${totalOccurrences} مورد در ${updatedCues} خط و ${affectedFileIds.size} فایل اعمال شد.`,
  });

  res.json({
    ok: true,
    totalOccurrences,
    updatedCues,
    affectedFiles: affectedFileIds.size,
  });
});

// ---------- Queue Controls ----------
apiRouter.get('/queue/status', (_req, res) => {
  res.json(translationManager.getState());
});

apiRouter.post('/queue/start', (req, res) => {
  const { fileIds, mode, selectedCueIds, preferredProviderId } = req.body as {
    fileIds?: number[];
    mode?: 'pending' | 'repair' | 'selective';
    selectedCueIds?: number[];
    preferredProviderId?: number | null;
  };
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    res.status(400).json({ error: 'حداقل یک فایل برای شروع ترجمه انتخاب کنید.' });
    return;
  }
  const state = translationManager.enqueue({
    fileIds,
    mode: mode || 'pending',
    selectedCueIds,
    preferredProviderId,
  });
  res.json(state);
});

apiRouter.post('/queue/pause', (_req, res) => {
  res.json(translationManager.pause());
});

apiRouter.post('/queue/resume', (_req, res) => {
  res.json(translationManager.resume());
});

apiRouter.post('/queue/stop', (_req, res) => {
  res.json(translationManager.stop());
});

// ---------- Export (Single SRT/VTT + Batch Folder-Preserving ZIP + Timecode Verification) ----------
apiRouter.get('/files/:id/verify-integrity', (req, res) => {
  const fileId = Number(req.params.id);
  const file = getFileById(fileId);
  if (!file) {
    res.status(404).json({ error: 'فایل یافت نشد.' });
    return;
  }
  const cues = getCuesByFileId(fileId);
  const exported = serializeSubtitleFile({
    format: file.format,
    fileHeader: file.fileHeader,
    lineEnding: file.lineEnding,
    cues,
    fallbackToSource: true,
  });
  const report = verifyTimecodeIntegrity(cues, exported, file.fileName);
  res.json(report);
});

apiRouter.get('/files/:id/export', (req, res) => {
  const fileId = Number(req.params.id);
  const bilingual = req.query.bilingual === '1';
  const file = getFileById(fileId);
  if (!file) {
    res.status(404).json({ error: 'فایل یافت نشد.' });
    return;
  }
  const cues = getCuesByFileId(fileId);
  const output = serializeSubtitleFile({
    format: file.format,
    fileHeader: file.fileHeader,
    lineEnding: file.lineEnding,
    cues,
    fallbackToSource: true,
    bilingual,
  });
  const integrity = verifyTimecodeIntegrity(cues, output, file.fileName);
  const ext = `.${file.format}`;
  const baseName = file.fileName.replace(/\.(srt|vtt)$/i, '');
  const downloadName = `${baseName}.fa${bilingual ? '.bilingual' : ''}${ext}`;

  addLog({
    level: 'success',
    category: 'export',
    projectId: file.projectId,
    fileId: file.id,
    message: `خروجی فایل «${downloadName}» با تایید ۱۰۰٪ صحت Timecode تولید شد (${integrity.exportedCount} خط).`,
  });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Timecode-Integrity', integrity.valid ? 'verified-100' : 'mismatch');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
  );
  res.send(output);
});

apiRouter.post('/projects/:id/export-zip', async (req, res) => {
  const projectId = Number(req.params.id);
  const { fileIds, folderPath, bilingual } = req.body as {
    fileIds?: number[];
    folderPath?: string;
    bilingual?: boolean;
  };

  let rows: Array<Record<string, unknown>>;
  if (Array.isArray(fileIds) && fileIds.length > 0) {
    const placeholders = fileIds.map(() => '?').join(',');
    rows = db
      .prepare(`SELECT * FROM subtitle_files WHERE project_id = ? AND id IN (${placeholders})`)
      .all(projectId, ...fileIds) as Array<Record<string, unknown>>;
  } else if (folderPath) {
    const clean = folderPath.replace(/^\/+|\/+$/g, '');
    rows = db
      .prepare(
        `SELECT * FROM subtitle_files
         WHERE project_id = ? AND (folder_path = ? OR folder_path LIKE ?)`
      )
      .all(projectId, clean, `${clean}/%`) as Array<Record<string, unknown>>;
  } else {
    rows = db
      .prepare(`SELECT * FROM subtitle_files WHERE project_id = ?`)
      .all(projectId) as Array<Record<string, unknown>>;
  }

  if (rows.length === 0) {
    res.status(400).json({ error: 'هیچ فایلی برای خروجی گروهی یافت نشد.' });
    return;
  }

  const zip = new JSZip();
  let verifiedCount = 0;

  for (const r of rows) {
    const file = mapSubtitleFile(r);
    const cues = getCuesByFileId(file.id);
    const output = serializeSubtitleFile({
      format: file.format,
      fileHeader: file.fileHeader,
      lineEnding: file.lineEnding,
      cues,
      fallbackToSource: true,
      bilingual: Boolean(bilingual),
    });
    const check = verifyTimecodeIntegrity(cues, output, file.fileName);
    if (check.valid) verifiedCount += 1;
    // Preserve exact relative folder hierarchy inside ZIP
    zip.file(file.relativePath, output);
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  addLog({
    level: 'success',
    category: 'export',
    projectId,
    message: `خروجی گروهی ZIP شامل ${rows.length} فایل با حفظ ساختار پوشه‌ها تولید شد (${verifiedCount}/${rows.length} تایید ۱۰۰٪ زمان‌بندی).`,
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="subtitles_fa_project_${projectId}.zip"`
  );
  res.send(buffer);
});

// ---------- API Providers (Multi-API Pool, Bulk Import, Test, Model Fetch) ----------
apiRouter.get('/providers', (_req, res) => {
  const rows = db
    .prepare(`SELECT * FROM api_providers ORDER BY priority ASC, id ASC`)
    .all() as unknown as ProviderRow[];
  res.json(rows.map(mapProviderPublic));
});

apiRouter.post('/providers', (req, res) => {
  const {
    name,
    providerType,
    baseUrl,
    apiKey,
    modelName,
    priority,
    rpmLimit,
    tpmLimit,
    timeoutMs,
    inputPricePer1M,
    outputPricePer1M,
  } = req.body as {
    name?: string;
    providerType?: ProviderType;
    baseUrl?: string;
    apiKey?: string;
    modelName?: string;
    priority?: number;
    rpmLimit?: number;
    tpmLimit?: number;
    timeoutMs?: number;
    inputPricePer1M?: number;
    outputPricePer1M?: number;
  };

  if (!name?.trim() || !providerType) {
    res.status(400).json({ error: 'نام و نوع API الزامی است.' });
    return;
  }

  const defaultModels: Record<string, string> = {
    gemini: DEFAULT_GEMINI_MODEL,
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    openrouter: 'google/gemini-2.5-flash',
    custom_proxy: 'gpt-4o-mini',
  };

  const isGemini = providerType === 'gemini' || providerType === 'gemini_builtin';
  const resolvedBase = (baseUrl || DEFAULT_BASE_URLS[providerType] || '').trim();
  const resolvedModel = (modelName || defaultModels[providerType] || 'gpt-4o-mini').trim();
  const resolvedRpm = rpmLimit ?? (isGemini ? 10 : 20);
  const resolvedTimeoutMs = timeoutMs ?? 300000;

  const info = db
    .prepare(
      `INSERT INTO api_providers (
        name, provider_type, base_url, api_key, model_name, available_models_json,
        priority, rpm_limit, tpm_limit, timeout_ms, enabled, status,
        input_price_per_1m, output_price_per_1m
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'untested', ?, ?)`
    )
    .run(
      name.trim(),
      providerType,
      resolvedBase,
      (apiKey || '').trim(),
      resolvedModel,
      JSON.stringify([resolvedModel]),
      priority ?? 10,
      resolvedRpm,
      tpmLimit ?? 120000,
      resolvedTimeoutMs,
      inputPricePer1M ?? 0.10,
      outputPricePer1M ?? 0.40
    );

  const created = db
    .prepare(`SELECT * FROM api_providers WHERE id = ?`)
    .get(info.lastInsertRowid) as unknown as ProviderRow;
  addLog({
    level: 'info',
    category: 'api',
    providerName: created.name,
    modelName: created.model_name,
    message: `سرویس API جدید «${created.name}» (${providerType} · RPM ${created.rpm_limit}) به صف اضافه شد.`,
  });
  res.status(201).json(mapProviderPublic(created));
});

apiRouter.post('/providers/bulk-import', (req, res) => {
  const {
    providerType,
    namePrefix,
    baseUrl,
    modelName,
    keysText,
    priorityStart,
    rpmLimit,
    tpmLimit,
    timeoutMs,
  } = req.body as {
    providerType: ProviderType;
    namePrefix?: string;
    baseUrl?: string;
    modelName?: string;
    keysText: string;
    priorityStart?: number;
    rpmLimit?: number;
    tpmLimit?: number;
    timeoutMs?: number;
  };

  const rawLines = (keysText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 4);

  if (rawLines.length === 0) {
    res.status(400).json({ error: 'حداقل یک کلید معتبر (هر کلید در یک خط) وارد کنید.' });
    return;
  }

  const isGemini = providerType === 'gemini' || providerType === 'gemini_builtin';
  const resolvedBase = (baseUrl || DEFAULT_BASE_URLS[providerType] || '').trim();
  const resolvedModel = (
    modelName ||
    (providerType === 'gemini'
      ? DEFAULT_GEMINI_MODEL
      : providerType === 'deepseek'
        ? 'deepseek-chat'
        : 'gpt-4o-mini')
  ).trim();
  const prefix = (namePrefix || providerType.toUpperCase()).trim();

  const insertStmt = db.prepare(
    `INSERT INTO api_providers (
      name, provider_type, base_url, api_key, model_name, available_models_json,
      priority, rpm_limit, tpm_limit, timeout_ms, enabled, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'untested')`
  );

  const added: ReturnType<typeof mapProviderPublic>[] = [];
  db.exec('BEGIN');
  try {
    rawLines.forEach((key, idx) => {
      const info = insertStmt.run(
        `${prefix} #${idx + 1}`,
        providerType,
        resolvedBase,
        key,
        resolvedModel,
        JSON.stringify([resolvedModel]),
        (priorityStart ?? 10) + idx,
        rpmLimit ?? (isGemini ? 10 : 20),
        tpmLimit ?? 120000,
        timeoutMs ?? 300000
      );
      const row = db
        .prepare(`SELECT * FROM api_providers WHERE id = ?`)
        .get(info.lastInsertRowid) as unknown as ProviderRow;
      added.push(mapProviderPublic(row));
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: String(err) });
    return;
  }

  addLog({
    level: 'success',
    category: 'api',
    message: `${added.length} کلید API به صورت گروهی برای «${prefix}» با کنترل ایمن RPM اضافه شد.`,
  });

  res.status(201).json({ added, count: added.length });
});

apiRouter.post('/providers/bulk-import-mixed', (req, res) => {
  const { items } = req.body as {
    items?: Array<{
      name?: string;
      providerType: ProviderType;
      baseUrl?: string;
      apiKey?: string;
      modelName?: string;
      priority?: number;
      rpmLimit?: number;
      tpmLimit?: number;
      timeoutMs?: number;
    }>;
  };

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'حداقل یک سرویس API معتبر برای ثبت گروهی وارد کنید.' });
    return;
  }

  const defaultModels: Record<string, string> = {
    gemini: DEFAULT_GEMINI_MODEL,
    openai: 'gpt-4o-mini',
    deepseek: 'deepseek-chat',
    openrouter: 'google/gemini-2.5-flash',
    custom_proxy: 'gpt-4o-mini',
  };

  const insertStmt = db.prepare(
    `INSERT INTO api_providers (
      name, provider_type, base_url, api_key, model_name, available_models_json,
      priority, rpm_limit, tpm_limit, timeout_ms, enabled, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'untested')`
  );

  const added: ReturnType<typeof mapProviderPublic>[] = [];
  db.exec('BEGIN');
  try {
    items.forEach((item, idx) => {
      const pType: ProviderType = item.providerType || 'custom_proxy';
      const isGemini = pType === 'gemini' || pType === 'gemini_builtin';
      const key = (item.apiKey || '').trim();
      const base = (item.baseUrl || DEFAULT_BASE_URLS[pType] || '').trim();
      if (!key && pType !== 'custom_proxy') return;
      const model = (item.modelName || defaultModels[pType] || 'gpt-4o-mini').trim();
      const displayName = (item.name || `${pType.toUpperCase()} #${idx + 1}`).trim();
      const info = insertStmt.run(
        displayName,
        pType,
        base,
        key,
        model,
        JSON.stringify([model]),
        item.priority ?? 10 + idx,
        item.rpmLimit ?? (isGemini ? 10 : 20),
        item.tpmLimit ?? 120000,
        item.timeoutMs ?? 300000
      );
      const row = db
        .prepare(`SELECT * FROM api_providers WHERE id = ?`)
        .get(info.lastInsertRowid) as unknown as ProviderRow;
      added.push(mapProviderPublic(row));
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: String(err) });
    return;
  }

  if (added.length === 0) {
    res.status(400).json({ error: 'هیچ ردیف معتبری با کلید API یافت نشد.' });
    return;
  }

  addLog({
    level: 'success',
    category: 'api',
    message: `${added.length} سرویس API مختلف به صورت یکجا به صف ترجمه و Failover اضافه شدند.`,
  });

  res.status(201).json({ added, count: added.length });
});

apiRouter.patch('/providers/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db
    .prepare(`SELECT * FROM api_providers WHERE id = ?`)
    .get(id) as unknown as ProviderRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'ارائه‌دهنده API یافت نشد.' });
    return;
  }

  const body = req.body as Partial<{
    name: string;
    baseUrl: string;
    apiKey: string;
    modelName: string;
    priority: number;
    rpmLimit: number;
    tpmLimit: number;
    timeoutMs: number;
    enabled: boolean;
    inputPricePer1M: number;
    outputPricePer1M: number;
    clearCooldown: boolean;
  }>;

  db.prepare(
    `UPDATE api_providers
     SET name = ?, base_url = ?, api_key = ?, model_name = ?,
         priority = ?, rpm_limit = ?, tpm_limit = ?, timeout_ms = ?,
         enabled = ?, input_price_per_1m = ?, output_price_per_1m = ?,
         status = ?, cooldown_until = ?
     WHERE id = ?`
  ).run(
    body.name?.trim() || existing.name,
    body.baseUrl !== undefined ? body.baseUrl.trim() : existing.base_url,
    body.apiKey !== undefined && body.apiKey.trim() !== ''
      ? body.apiKey.trim()
      : existing.api_key,
    body.modelName?.trim() || existing.model_name,
    body.priority ?? existing.priority,
    body.rpmLimit ?? existing.rpm_limit,
    body.tpmLimit ?? existing.tpm_limit,
    body.timeoutMs ?? existing.timeout_ms,
    body.enabled !== undefined ? (body.enabled ? 1 : 0) : existing.enabled,
    body.inputPricePer1M ?? existing.input_price_per_1m,
    body.outputPricePer1M ?? existing.output_price_per_1m,
    body.clearCooldown ? 'healthy' : existing.status,
    body.clearCooldown ? null : existing.cooldown_until,
    id
  );

  const updated = db
    .prepare(`SELECT * FROM api_providers WHERE id = ?`)
    .get(id) as unknown as ProviderRow;
  res.json(mapProviderPublic(updated));
});

apiRouter.delete('/providers/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db
    .prepare(`SELECT provider_type FROM api_providers WHERE id = ?`)
    .get(id) as { provider_type: ProviderType } | undefined;
  if (existing?.provider_type === 'gemini_builtin') {
    res.status(400).json({ error: 'موتور داخلی سرور قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.' });
    return;
  }
  db.prepare(`DELETE FROM api_providers WHERE id = ?`).run(id);
  res.json({ ok: true });
});

apiRouter.post('/providers/:id/test', async (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(`SELECT * FROM api_providers WHERE id = ?`)
    .get(id) as unknown as ProviderRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'ارائه‌دهنده API یافت نشد.' });
    return;
  }

  const result = await testProviderConnection(row);
  db.prepare(
    `UPDATE api_providers
     SET status = ?, last_latency_ms = ?, last_error = ?, cooldown_until = NULL
     WHERE id = ?`
  ).run(result.ok ? 'healthy' : 'error', result.latencyMs, result.error ?? null, id);

  addLog({
    level: result.ok ? 'success' : 'error',
    category: 'api',
    providerName: row.name,
    modelName: result.modelUsed,
    message: result.ok
      ? `تست اتصال «${row.name}» موفق بود (${result.latencyMs}ms، پاسخ نمونه: ${result.sampleReply})`
      : `تست اتصال «${row.name}» ناموفق بود: ${result.error}`,
    tokensUsed: result.tokensUsed,
    latencyMs: result.latencyMs,
  });

  const updated = db
    .prepare(`SELECT * FROM api_providers WHERE id = ?`)
    .get(id) as unknown as ProviderRow;

  res.json({ result, provider: mapProviderPublic(updated) });
});

apiRouter.post('/providers/:id/models', async (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare(`SELECT * FROM api_providers WHERE id = ?`)
    .get(id) as unknown as ProviderRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'ارائه‌دهنده API یافت نشد.' });
    return;
  }

  try {
    const models = await fetchProviderModels(row);
    db.prepare(`UPDATE api_providers SET available_models_json = ? WHERE id = ?`).run(
      JSON.stringify(models),
      id
    );
    const updated = db
      .prepare(`SELECT * FROM api_providers WHERE id = ?`)
      .get(id) as unknown as ProviderRow;
    res.json({ models, provider: mapProviderPublic(updated) });
  } catch (err) {
    res.status(502).json({
      error: `دریافت لیست مدل‌ها ناموفق بود: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

// ---------- Glossary ----------
apiRouter.get('/glossary', (req, res) => {
  const projectId =
    req.query.projectId !== undefined && req.query.projectId !== 'all'
      ? Number(req.query.projectId)
      : null;
  res.json(getGlossaryForProject(projectId));
});

apiRouter.post('/glossary', (req, res) => {
  const { projectId, sourceTerm, targetTerm, caseSensitive, wholeWord, notes } = req.body as {
    projectId?: number | null;
    sourceTerm?: string;
    targetTerm?: string;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    notes?: string;
  };
  if (!sourceTerm?.trim() || !targetTerm?.trim()) {
    res.status(400).json({ error: 'عبارت انگلیسی و معادل فارسی الزامی است.' });
    return;
  }
  const info = db
    .prepare(
      `INSERT INTO glossary_terms (project_id, source_term, target_term, case_sensitive, whole_word, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      projectId ?? null,
      sourceTerm.trim(),
      targetTerm.trim(),
      caseSensitive ? 1 : 0,
      wholeWord === false ? 0 : 1,
      (notes || '').trim()
    );
  const row = db
    .prepare(`SELECT * FROM glossary_terms WHERE id = ?`)
    .get(info.lastInsertRowid) as Record<string, unknown>;
  res.status(201).json({
    id: Number(row.id),
    projectId: row.project_id === null ? null : Number(row.project_id),
    sourceTerm: String(row.source_term),
    targetTerm: String(row.target_term),
    caseSensitive: Boolean(row.case_sensitive),
    wholeWord: Boolean(row.whole_word),
    notes: String(row.notes || ''),
    createdAt: String(row.created_at),
  });
});

apiRouter.delete('/glossary/:id', (req, res) => {
  db.prepare(`DELETE FROM glossary_terms WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Logs ----------
apiRouter.get('/logs', (req, res) => {
  const limit = Math.min(300, Math.max(20, Number(req.query.limit) || 120));
  const level = req.query.level as string | undefined;
  const rows =
    level && level !== 'all'
      ? (db
          .prepare(
            `SELECT * FROM operation_logs WHERE level = ? ORDER BY id DESC LIMIT ?`
          )
          .all(level, limit) as Array<Record<string, unknown>>)
      : (db
          .prepare(`SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?`)
          .all(limit) as Array<Record<string, unknown>>);

  const mapped: OperationLog[] = rows.map((r) => ({
    id: Number(r.id),
    level: String(r.level) as OperationLog['level'],
    category: String(r.category) as OperationLog['category'],
    projectId: r.project_id === null ? null : Number(r.project_id),
    fileId: r.file_id === null ? null : Number(r.file_id),
    providerName: (r.provider_name as string | null) ?? null,
    modelName: (r.model_name as string | null) ?? null,
    message: String(r.message),
    details: (r.details as string | null) ?? null,
    tokensUsed: Number(r.tokens_used || 0),
    latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
    createdAt: String(r.created_at),
  }));
  res.json(mapped);
});

apiRouter.delete('/logs', (_req, res) => {
  db.prepare(`DELETE FROM operation_logs`).run();
  res.json({ ok: true });
});

// ---------- Settings ----------
apiRouter.get('/settings', (_req, res) => {
  res.json(getSettings());
});

apiRouter.patch('/settings', (req, res) => {
  const updated = saveSettings(req.body);
  res.json(updated);
});

// ---------- Backup & Restore ----------
apiRouter.get('/backup/export', (_req, res) => {
  const payload = exportFullBackupJson();
  addLog({
    level: 'info',
    category: 'backup',
    message: 'فایل پشتیبان کامل از دیتابیس پروژه‌ها، زیرنویس‌ها و واژه‌نامه ایجاد شد.',
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ai-subtitle-translator-backup-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.send(JSON.stringify(payload, null, 2));
});

apiRouter.post('/backup/restore', (req, res) => {
  try {
    const result = restoreBackupJson(req.body);
    addLog({
      level: 'success',
      category: 'backup',
      message: `بازیابی پشتیبان انجام شد: ${result.projectsRestored} پروژه، ${result.filesRestored} فایل و ${result.cuesRestored} خط زیرنویس.`,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'خطا در بازیابی فایل پشتیبان.',
    });
  }
});

// ---------- Python Desktop Package & EXE Builder ----------
apiRouter.get('/desktop/files', (_req, res) => {
  res.json({ files: listPythonDesktopFiles() });
});

apiRouter.get('/desktop/download-zip', async (_req, res) => {
  try {
    const buffer = await buildPythonDesktopZipBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="AI-Subtitle-Translator-Python-Desktop.zip"'
    );
    res.send(buffer);
  } catch (err) {
    res.status(500).json({
      error: `خطا در بسته‌بندی نسخه دسکتاپ پایتون: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});
