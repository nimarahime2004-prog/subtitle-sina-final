import React, { useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileText,
  FileUp,
  Folder,
  FolderUp,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import type {
  FolderToneRule,
  Project,
  SubtitleFile,
  TranslationTone,
} from '../shared/types.ts';
import { TONE_PRESETS } from '../shared/types.ts';
import { api, readSelectedSubtitleFiles } from '../lib/api.ts';

interface ProjectsViewProps {
  projects: Project[];
  activeProject: Project | null;
  files: SubtitleFile[];
  folderTones: FolderToneRule[];
  onSelectProject: (projectId: number) => void;
  onCreateProject: (body: {
    name: string;
    description: string;
    defaultTone: TranslationTone;
    customTonePrompt: string;
  }) => Promise<void>;
  onUpdateProjectTone: (
    projectId: number,
    tone: TranslationTone,
    customPrompt: string
  ) => Promise<void>;
  onDeleteProject: (projectId: number) => Promise<void>;
  onSetFolderTone: (
    folderPath: string,
    tone: TranslationTone | null,
    customPrompt?: string
  ) => Promise<void>;
  onDeleteFolder: (folderPath: string) => Promise<void>;
  onSetFileTone: (
    fileId: number,
    tone: TranslationTone | null,
    customPrompt?: string | null
  ) => Promise<void>;
  onDeleteFile: (fileId: number) => Promise<void>;
  onBulkDeleteFiles: (fileIds: number[]) => Promise<void>;
  onImportFiles: (items: Array<{ relativePath: string; content: string }>) => Promise<void>;
  onTranslateFiles: (fileIds: number[], mode: 'pending' | 'repair') => Promise<void>;
  onOpenEditor: (fileId: number) => void;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export function ProjectsView({
  projects,
  activeProject,
  files,
  folderTones,
  onSelectProject,
  onCreateProject,
  onUpdateProjectTone,
  onDeleteProject,
  onSetFolderTone,
  onDeleteFolder,
  onSetFileTone,
  onDeleteFile,
  onBulkDeleteFiles,
  onImportFiles,
  onTranslateFiles,
  onOpenEditor,
  onNotify,
}: ProjectsViewProps) {
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newTone, setNewTone] = useState<TranslationTone>('documentary_direct');
  const [newCustomPrompt, setNewCustomPrompt] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string>('__ALL__');
  const [bilingualExport, setBilingualExport] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(new Set());
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<string | null>(null);
  const [confirmDeleteFileId, setConfirmDeleteFileId] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const folders = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) {
      if (f.folderPath) {
        const parts = f.folderPath.split('/').filter(Boolean);
        let acc = '';
        for (const p of parts) {
          acc = acc ? `${acc}/${p}` : p;
          set.add(acc);
        }
      }
    }
    return Array.from(set).sort();
  }, [files]);

  const folderToneMap = useMemo(() => {
    const map = new Map<string, FolderToneRule>();
    for (const r of folderTones) {
      map.set(r.folderPath, r);
    }
    return map;
  }, [folderTones]);

  const visibleFiles = useMemo(() => {
    if (selectedFolder === '__ALL__') return files;
    if (selectedFolder === '__ROOT__') return files.filter((f) => !f.folderPath);
    return files.filter(
      (f) => f.folderPath === selectedFolder || f.folderPath.startsWith(`${selectedFolder}/`)
    );
  }, [files, selectedFolder]);

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const items = await readSelectedSubtitleFiles(e.target.files);
    e.target.value = '';
    if (items.length > 0) {
      await onImportFiles(items);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    await onCreateProject({
      name: newName.trim(),
      description: newDesc.trim(),
      defaultTone: newTone,
      customTonePrompt: newCustomPrompt.trim(),
    });
    setNewName('');
    setNewDesc('');
    setNewCustomPrompt('');
    setShowNewForm(false);
  };

  const handleExportFolderZip = async (folderPath?: string) => {
    if (!activeProject) return;
    try {
      await api.exportZip(activeProject.id, {
        folderPath:
          folderPath && folderPath !== '__ALL__' && folderPath !== '__ROOT__'
            ? folderPath
            : undefined,
        bilingual: bilingualExport,
      });
      onNotify(
        'خروجی گروهی ZIP با حفظ ساختار پوشه‌ها و تایید ۱۰۰٪ زمان‌بندی آماده شد.',
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در خروجی ZIP', 'error');
    }
  };

  const handleVerifyIntegrity = async (fileId: number, fileName: string) => {
    try {
      const report = await api.verifyIntegrity(fileId);
      if (report.valid) {
        onNotify(
          `تایید ۱۰۰٪ یکپارچگی Timecode برای «${fileName}»: تمام ${report.exportedCount} خط کاملاً منطبق با فایل اصلی هستند.`,
          'success'
        );
      } else {
        onNotify(
          `عدم تطابق در ${report.mismatches.length} خط از «${fileName}» شناسایی شد.`,
          'error'
        );
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در بررسی یکپارچگی', 'error');
    }
  };

  const toggleSelectFile = (id: number) => {
    setSelectedFileIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (
      visibleFiles.length > 0 &&
      visibleFiles.every((f) => selectedFileIds.has(f.id))
    ) {
      setSelectedFileIds(new Set());
    } else {
      setSelectedFileIds(new Set(visibleFiles.map((f) => f.id)));
    }
  };

  const handleConfirmFolderDelete = async (folderPath: string) => {
    await onDeleteFolder(folderPath);
    setConfirmDeleteFolder(null);
    setSelectedFileIds(new Set());
    if (selectedFolder === folderPath || selectedFolder.startsWith(`${folderPath}/`)) {
      setSelectedFolder('__ALL__');
    }
  };

  const handleBulkDeleteSelected = async () => {
    const ids = Array.from(selectedFileIds);
    if (ids.length === 0) return;
    await onBulkDeleteFiles(ids);
    setSelectedFileIds(new Set());
  };

  const activeFolderRule =
    selectedFolder !== '__ALL__' && selectedFolder !== '__ROOT__'
      ? folderToneMap.get(selectedFolder)
      : undefined;

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".srt,.vtt"
        onChange={handleImport}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory enables recursive folder import
        webkitdirectory=""
        directory=""
        onChange={handleImport}
        className="hidden"
      />

      {/* Top Project Selector & Tone Configuration */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400">
              پروژه فعال:
            </label>
            <select
              value={activeProject?.id ?? ''}
              onChange={(e) => {
                setSelectedFolder('__ALL__');
                setSelectedFileIds(new Set());
                onSelectProject(Number(e.target.value));
              }}
              className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.fileCount ?? 0} فایل)
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => setShowNewForm((s) => !s)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              پروژه جدید
            </button>

            {activeProject && projects.length > 1 && (
              <button
                type="button"
                onClick={() => onDeleteProject(activeProject.id)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                حذف پروژه
              </button>
            )}
          </div>

          {activeProject && (
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                لحن پیش‌فرض پروژه:
              </span>
              <select
                value={activeProject.defaultTone}
                onChange={(e) =>
                  onUpdateProjectTone(
                    activeProject.id,
                    e.target.value as TranslationTone,
                    activeProject.customTonePrompt
                  )
                }
                className="px-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              >
                {TONE_PRESETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.labelFa}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {activeProject?.defaultTone === 'custom' && (
          <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              defaultValue={activeProject.customTonePrompt}
              placeholder="دستورالعمل لحن سفارشی پروژه را بنویسید..."
              onBlur={(e) =>
                onUpdateProjectTone(activeProject.id, 'custom', e.target.value)
              }
              className="flex-1 px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            />
          </div>
        )}

        {showNewForm && (
          <form
            onSubmit={handleCreate}
            className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 md:grid-cols-3 gap-3"
          >
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="نام پروژه (مثلاً: مستند تاریخ علم)"
              className="px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            />
            <select
              value={newTone}
              onChange={(e) => setNewTone(e.target.value as TranslationTone)}
              className="px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            >
              {TONE_PRESETS.map((t) => (
                <option key={t.id} value={t.id}>
                  لحن: {t.labelFa}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="توضیح کوتاه (اختیاری)"
              className="px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            />
            {newTone === 'custom' && (
              <input
                type="text"
                value={newCustomPrompt}
                onChange={(e) => setNewCustomPrompt(e.target.value)}
                placeholder="دستورالعمل لحن سفارشی..."
                className="md:col-span-3 px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              />
            )}
            <div className="md:col-span-3 flex items-center gap-2">
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
              >
                ایجاد پروژه
              </button>
              <button
                type="button"
                onClick={() => setShowNewForm(false)}
                className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
              >
                انصراف
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Main Split: Folder Tree + Files inside Selected Folder */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Folder Tree Panel */}
        <div className="lg:col-span-4 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="flex items-center justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
            <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              ساختار پوشه‌های پروژه
            </h3>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                title="ورود فایل"
              >
                <FileUp className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="p-1.5 rounded-md text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                title="ورود پوشه با ساختار"
              >
                <FolderUp className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="mt-2.5 space-y-1">
            <button
              type="button"
              onClick={() => {
                setSelectedFolder('__ALL__');
                setConfirmDeleteFolder(null);
              }}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors cursor-pointer ${
                selectedFolder === '__ALL__'
                  ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400 font-semibold'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
              }`}
            >
              <span>همه فایل‌های پروژه</span>
              <span className="font-mono tabular-nums text-[11px]">{files.length}</span>
            </button>

            {files.some((f) => !f.folderPath) && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFolder('__ROOT__');
                    setConfirmDeleteFolder(null);
                  }}
                  className={`flex-1 flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors cursor-pointer ${
                    selectedFolder === '__ROOT__'
                      ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400 font-semibold'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                  }`}
                >
                  <span>فایل‌های ریشه (بدون پوشه)</span>
                  <span className="font-mono tabular-nums text-[11px]">
                    {files.filter((f) => !f.folderPath).length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteFolder('')}
                  className="p-1.5 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                  title="حذف فایل‌های ریشه"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {folders.map((folder) => {
              const depth = folder.split('/').length - 1;
              const count = files.filter(
                (f) => f.folderPath === folder || f.folderPath.startsWith(`${folder}/`)
              ).length;
              const rule = folderToneMap.get(folder);
              const ruleLabel = rule
                ? TONE_PRESETS.find((t) => t.id === rule.tone)?.labelFa.replace(' (پیش‌فرض)', '')
                : null;
              return (
                <div key={folder} className="space-y-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFolder(folder);
                        setConfirmDeleteFolder(null);
                      }}
                      style={{ paddingRight: `${12 + depth * 14}px` }}
                      className={`flex-1 min-w-0 flex items-center justify-between pl-2.5 py-2 rounded-lg text-xs transition-colors cursor-pointer ${
                        selectedFolder === folder
                          ? 'bg-blue-600/10 text-blue-600 dark:text-blue-400 font-semibold'
                          : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Folder className="w-3.5 h-3.5 shrink-0 opacity-75" />
                        <span className="truncate font-en" dir="ltr">
                          {folder.split('/').pop()}
                        </span>
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0 text-[11px] text-slate-500 dark:text-slate-400">
                        {ruleLabel && <span className="truncate max-w-[90px]">{ruleLabel} ·</span>}
                        <span className="font-mono tabular-nums">{count}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteFolder(folder)}
                      className="p-1.5 rounded-md text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer shrink-0"
                      title={`حذف پوشه ${folder}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {confirmDeleteFolder === folder && (
                    <div className="mr-3 p-2.5 rounded-lg bg-red-50 dark:bg-red-950/35 border border-red-200 dark:border-red-900/60 text-[11px] space-y-2">
                      <div className="text-red-700 dark:text-red-300">
                        پوشه «{folder}» و تمام {count} زیرنویس داخل آن حذف شوند؟
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleConfirmFolderDelete(folder)}
                          className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium cursor-pointer"
                        >
                          بله، حذف پوشه
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteFolder(null)}
                          className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                        >
                          انصراف
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {confirmDeleteFolder === '' && (
              <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/35 border border-red-200 dark:border-red-900/60 text-[11px] space-y-2">
                <div className="text-red-700 dark:text-red-300">
                  همه فایل‌های ریشه (بدون پوشه) حذف شوند؟
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleConfirmFolderDelete('')}
                    className="px-2.5 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium cursor-pointer"
                  >
                    بله، حذف کن
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteFolder(null)}
                    className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
                  >
                    انصراف
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Per-Folder Tone Override Box */}
          {selectedFolder !== '__ALL__' && selectedFolder !== '__ROOT__' && (
            <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                  تنظیم لحن اختصاصی پوشه
                </div>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteFolder(selectedFolder)}
                  className="text-[11px] text-red-600 dark:text-red-400 hover:underline cursor-pointer"
                >
                  حذف این پوشه
                </button>
              </div>
              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate" dir="ltr">
                {selectedFolder}
              </div>
              <select
                value={activeFolderRule?.tone ?? ''}
                onChange={(e) => {
                  const val = e.target.value as TranslationTone | '';
                  onSetFolderTone(selectedFolder, val ? val : null, activeFolderRule?.customPrompt);
                }}
                className="w-full px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
              >
                <option value="">ارث‌بری از لحن پیش‌فرض پروژه</option>
                {TONE_PRESETS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.labelFa}
                  </option>
                ))}
              </select>
              {activeFolderRule?.tone === 'custom' && (
                <input
                  type="text"
                  defaultValue={activeFolderRule.customPrompt}
                  placeholder="دستورالعمل لحن سفارشی این پوشه..."
                  onBlur={(e) => onSetFolderTone(selectedFolder, 'custom', e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                />
              )}
            </div>
          )}
        </div>

        {/* Files List in Folder */}
        <div className="lg:col-span-8 bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {visibleFiles.length > 0 && (
                <input
                  type="checkbox"
                  checked={
                    visibleFiles.length > 0 &&
                    visibleFiles.every((f) => selectedFileIds.has(f.id))
                  }
                  onChange={toggleSelectAllVisible}
                  title="انتخاب همه فایل‌های نمایش‌داده‌شده"
                />
              )}
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                  {selectedFolder === '__ALL__'
                    ? 'همه فایل‌های پروژه'
                    : selectedFolder === '__ROOT__'
                      ? 'فایل‌های ریشه'
                      : `پوشه: ${selectedFolder}`}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {visibleFiles.length} فایل · امکان ترجمه گروهی، حذف فایل/پوشه و تنظیم لحن اختصاصی
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {selectedFileIds.size > 0 && (
                <button
                  type="button"
                  onClick={handleBulkDeleteSelected}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-red-300 dark:border-red-900/70 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/35 cursor-pointer whitespace-nowrap"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  حذف انتخاب‌شده‌ها ({selectedFileIds.size})
                </button>
              )}

              <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer ml-1">
                <input
                  type="checkbox"
                  checked={bilingualExport}
                  onChange={(e) => setBilingualExport(e.target.checked)}
                  className="rounded border-slate-400"
                />
                خروجی دوزبانه
              </label>

              <button
                type="button"
                disabled={visibleFiles.length === 0}
                onClick={() =>
                  onTranslateFiles(
                    visibleFiles.map((f) => f.id),
                    'pending'
                  )
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-45 text-white cursor-pointer whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                ترجمه این پوشه ({visibleFiles.length})
              </button>
              <button
                type="button"
                disabled={visibleFiles.length === 0}
                onClick={() => handleExportFolderZip(selectedFolder)}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 cursor-pointer whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                خروجی ZIP
              </button>
            </div>
          </div>

          {visibleFiles.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500 dark:text-slate-400">
              فایلی در این بخش وجود ندارد. از دکمه‌های بالا برای وارد کردن فایل یا پوشه استفاده کنید.
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {visibleFiles.map((file) => {
                const pct =
                  file.totalCues > 0
                    ? Math.round((file.completedCues / file.totalCues) * 100)
                    : 0;
                return (
                  <div
                    key={file.id}
                    className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/35 transition-colors"
                  >
                    <div className="min-w-0 flex-1 flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selectedFileIds.has(file.id)}
                        onChange={() => toggleSelectFile(file.id)}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                          <button
                            type="button"
                            onClick={() => onOpenEditor(file.id)}
                            className="text-xs font-semibold text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 truncate font-en cursor-pointer"
                            dir="ltr"
                          >
                            {file.relativePath}
                          </button>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                          <span className="uppercase">{file.format}</span>
                          <span>·</span>
                          <span>
                            {file.completedCues}/{file.totalCues} ({pct}%)
                          </span>
                          <span>·</span>
                          <span>{file.totalTokens.toLocaleString()} توکن</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <select
                        value={file.toneOverride ?? ''}
                        onChange={(e) => {
                          const v = e.target.value as TranslationTone | '';
                          onSetFileTone(file.id, v ? v : null, file.customToneOverride);
                        }}
                        className="px-2.5 py-1.5 text-[11px] rounded-md bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200"
                        title="لحن اختصاصی این فایل"
                      >
                        <option value="">لحن پیش‌فرض</option>
                        {TONE_PRESETS.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.labelFa}
                          </option>
                        ))}
                      </select>

                      <button
                        type="button"
                        onClick={() => handleVerifyIntegrity(file.id, file.fileName)}
                        className="p-1.5 rounded-md text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                        title="تست یکپارچگی ۱۰۰٪ Timecode"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                      </button>

                      <a
                        href={api.exportSingleFileUrl(file.id, bilingualExport)}
                        download
                        className="p-1.5 rounded-md text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800"
                        title="دانلود فایل ترجمه‌شده"
                      >
                        <Download className="w-4 h-4" />
                      </a>

                      {confirmDeleteFileId === file.id ? (
                        <div className="inline-flex items-center gap-1.5 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              await onDeleteFile(file.id);
                              setConfirmDeleteFileId(null);
                            }}
                            className="px-2 py-1 rounded bg-red-600 text-white font-medium cursor-pointer"
                          >
                            حذف شود
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteFileId(null)}
                            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 text-slate-500 cursor-pointer"
                          >
                            لغو
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteFileId(file.id)}
                          className="p-1.5 rounded-md text-slate-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                          title="حذف زیرنویس"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
