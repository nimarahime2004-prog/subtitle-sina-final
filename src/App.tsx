import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BookMarked,
  FileCode2,
  FolderTree,
  KeyRound,
  LayoutDashboard,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import type {
  ApiProvider,
  AppSettings,
  DashboardSummary,
  FolderToneRule,
  GlossaryTerm,
  OperationLog,
  Project,
  SubtitleFile,
  TranslationTone,
} from './shared/types.ts';
import { api } from './lib/api.ts';
import { DashboardView } from './components/DashboardView.tsx';
import { ProjectsView } from './components/ProjectsView.tsx';
import { EditorView } from './components/EditorView.tsx';
import { ProvidersView } from './components/ProvidersView.tsx';
import { GlossaryView } from './components/GlossaryView.tsx';
import { LogsView } from './components/LogsView.tsx';
import { SettingsDesktopView } from './components/SettingsDesktopView.tsx';

type NavSection =
  | 'dashboard'
  | 'projects'
  | 'editor'
  | 'providers'
  | 'glossary'
  | 'logs'
  | 'settings';

const NAV_ITEMS: Array<{
  id: NavSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'dashboard', label: 'داشبورد و صف ترجمه', icon: LayoutDashboard },
  { id: 'projects', label: 'پروژه‌ها و پوشه‌ها', icon: FolderTree },
  { id: 'editor', label: 'ادیتور دوزبانه', icon: FileCode2 },
  { id: 'providers', label: 'مدیریت APIها', icon: KeyRound },
  { id: 'glossary', label: 'واژه‌نامه اختصاصی', icon: BookMarked },
  { id: 'logs', label: 'گزارش‌ها و مصرف', icon: Activity },
  { id: 'settings', label: 'تنظیمات و نسخه EXE', icon: Settings },
];

const DEFAULT_SETTINGS_CLIENT: AppSettings = {
  maxConcurrentFiles: 2,
  batchSize: 18,
  contextBefore: 4,
  contextAfter: 3,
  maxRetries: 4,
  adaptiveProxyTimeoutMs: 300000,
  autoRepairIncomplete: true,
  preserveHtmlTags: true,
};

export default function App() {
  const [nav, setNav] = useState<NavSection>('dashboard');
  const [isDark, setIsDark] = useState(true);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [files, setFiles] = useState<SubtitleFile[]>([]);
  const [folderTones, setFolderTones] = useState<FolderToneRule[]>([]);
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [providers, setProviders] = useState<ApiProvider[]>([]);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS_CLIENT);
  const [refreshTick, setRefreshTick] = useState(0);

  const [toast, setToast] = useState<{
    message: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);

  const notify = useCallback(
    (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      setToast({ message, type });
    },
    []
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  const loadCoreData = useCallback(async (projIdOverride?: number | null) => {
    try {
      const [dash, projs, provs, sets] = await Promise.all([
        api.getDashboard(),
        api.getProjects(),
        api.getProviders(),
        api.getSettings(),
      ]);
      setSummary(dash);
      setProjects(projs);
      setProviders(provs);
      setSettings(sets);

      const resolvedPid =
        projIdOverride ??
        activeProjectId ??
        projs[0]?.id ??
        null;
      if (resolvedPid && resolvedPid !== activeProjectId) {
        setActiveProjectId(resolvedPid);
      }

      if (resolvedPid) {
        const [projFiles, fTones, glos] = await Promise.all([
          api.getProjectFiles(resolvedPid),
          api.getFolderTones(resolvedPid),
          api.getGlossary(resolvedPid),
        ]);
        setFiles(projFiles);
        setFolderTones(fTones);
        setGlossary(glos);
      } else {
        setFiles([]);
        setFolderTones([]);
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : 'خطا در اتصال به سرور', 'error');
    }
  }, [activeProjectId, notify]);

  const loadLogs = useCallback(async (level = 'all') => {
    try {
      const data = await api.getLogs(level);
      setLogs(data);
    } catch {
      // ignore transient log load failure
    }
  }, []);

  useEffect(() => {
    void loadCoreData();
    void loadLogs();
  }, [loadCoreData, loadLogs]);

  // Real-time polling while queue is running or paused
  const isQueueActive =
    summary?.queue.state === 'running' ||
    summary?.queue.state === 'paused' ||
    summary?.queue.state === 'stopping';

  useEffect(() => {
    if (!isQueueActive) return;
    const timer = setInterval(async () => {
      try {
        const [dash, provs] = await Promise.all([
          api.getDashboard(),
          api.getProviders(),
        ]);
        setSummary(dash);
        setProviders(provs);
        if (activeProjectId) {
          const projFiles = await api.getProjectFiles(activeProjectId);
          setFiles(projFiles);
        }
        setRefreshTick((t) => t + 1);
      } catch {
        // retry on next tick
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [isQueueActive, activeProjectId]);

  const activeProject =
    projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

  const handleSelectProject = async (projectId: number) => {
    setActiveProjectId(projectId);
    setSelectedFileId(null);
    await loadCoreData(projectId);
  };

  const handleImportFiles = async (
    items: Array<{ relativePath: string; content: string }>
  ) => {
    if (!activeProject) return;
    try {
      const res = await api.importFiles(activeProject.id, items);
      await loadCoreData(activeProject.id);
      notify(
        `${res.count} فایل زیرنویس با حفظ ساختار پوشه‌ها و قفل Timecode وارد شد.`,
        'success'
      );
    } catch (err) {
      notify(err instanceof Error ? err.message : 'خطا در وارد کردن فایل‌ها', 'error');
    }
  };

  const handleLoadSample = async () => {
    if (!activeProject) return;
    try {
      const res = await api.loadSampleFiles(activeProject.id);
      await loadCoreData(activeProject.id);
      if (res.imported[0]) {
        setSelectedFileId(res.imported[0].id);
      }
      notify('۲ فایل نمونه SRT و VTT در پوشه‌های مجزا بارگذاری شدند.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'خطا در بارگذاری نمونه', 'error');
    }
  };

  const handleStartQueue = async (
    fileIds: number[],
    mode: 'pending' | 'repair' | 'selective',
    selectedCueIds?: number[]
  ) => {
    if (fileIds.length === 0) return;
    try {
      await api.startQueue({ fileIds, mode, selectedCueIds });
      await loadCoreData(activeProject?.id);
      notify('صف ترجمه هوشمند آغاز به کار کرد.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'خطا در شروع صف ترجمه', 'error');
    }
  };

  const handleOpenEditor = (fileId: number) => {
    setSelectedFileId(fileId);
    setNav('editor');
  };

  const currentSectionTitle =
    NAV_ITEMS.find((i) => i.id === nav)?.label ?? 'داشبورد';

  return (
    <div className="min-h-screen flex bg-slate-50 dark:bg-[#0B1120] text-slate-900 dark:text-slate-100">
      {/* Right-aligned RTL Sidebar */}
      <aside className="w-60 shrink-0 hidden md:flex flex-col border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A]">
        <div className="h-16 px-5 flex items-center border-b border-slate-200 dark:border-slate-800">
          <span className="font-en text-sm font-bold tracking-tight text-slate-900 dark:text-slate-50 whitespace-nowrap">
            AI Subtitle Translator
          </span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = nav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setNav(item.id);
                  if (item.id === 'logs') void loadLogs();
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 space-y-1">
          <div className="flex items-center justify-between">
            <span>حفظ Timecode</span>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">100%</span>
          </div>
          <div className="flex items-center justify-between">
            <span>دیتابیس SQLite</span>
            <span>ذخیره خودکار</span>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean 3-zone Top Header */}
        <header className="h-16 px-5 lg:px-7 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A] flex items-center justify-between gap-6 shrink-0">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
              {activeProject?.name ?? 'پروژه'}
            </span>
            <span className="text-slate-300 dark:text-slate-700 hidden sm:inline">/</span>
            <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-50 truncate">
              {currentSectionTitle}
            </h1>
          </div>

          {/* Mobile compact nav selector */}
          <select
            value={nav}
            onChange={(e) => setNav(e.target.value as NavSection)}
            className="md:hidden px-2.5 py-1.5 text-xs rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700"
          >
            {NAV_ITEMS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsDark((d) => !d)}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              title={isDark ? 'تغییر به پوسته روشن' : 'تغییر به پوسته تیره'}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <a
              href="/api/desktop/download-zip"
              download
              className="hidden sm:inline-flex items-center px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap shrink-0"
            >
              دریافت نسخه دسکتاپ Python
            </a>
          </div>
        </header>

        {/* Non-intrusive Toast Banner */}
        {toast && (
          <div className="px-5 lg:px-7 pt-4">
            <div
              className={`px-4 py-2.5 rounded-lg text-xs font-medium border flex items-center justify-between gap-3 ${
                toast.type === 'success'
                  ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                  : toast.type === 'error'
                    ? 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300'
                    : 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-300'
              }`}
            >
              <span>{toast.message}</span>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="text-[11px] opacity-75 hover:opacity-100 cursor-pointer"
              >
                بستن
              </button>
            </div>
          </div>
        )}

        {/* Viewport Content */}
        <main className="flex-1 p-5 lg:p-7 max-w-[1440px] w-full mx-auto">
          {nav === 'dashboard' && (
            <DashboardView
              summary={summary}
              files={files}
              providers={providers}
              activeProjectId={activeProject?.id ?? null}
              onImportFiles={handleImportFiles}
              onLoadSample={handleLoadSample}
              onStartQueue={(ids, mode) => handleStartQueue(ids, mode)}
              onPauseQueue={async () => {
                await api.pauseQueue();
                await loadCoreData(activeProject?.id);
              }}
              onResumeQueue={async () => {
                await api.resumeQueue();
                await loadCoreData(activeProject?.id);
              }}
              onStopQueue={async () => {
                await api.stopQueue();
                await loadCoreData(activeProject?.id);
              }}
              onOpenEditor={handleOpenEditor}
              onDeleteFile={async (fileId) => {
                await api.deleteFile(fileId);
                if (selectedFileId === fileId) setSelectedFileId(null);
                await loadCoreData(activeProject?.id);
                notify('فایل زیرنویس حذف شد.', 'info');
              }}
              onExportAllZip={async () => {
                if (!activeProject) return;
                await api.exportZip(activeProject.id, {});
                notify('خروجی گروهی ZIP آماده دانلود شد.', 'success');
              }}
            />
          )}

          {nav === 'projects' && (
            <ProjectsView
              projects={projects}
              activeProject={activeProject}
              files={files}
              folderTones={folderTones}
              onSelectProject={handleSelectProject}
              onCreateProject={async (body) => {
                const created = await api.createProject(body);
                await handleSelectProject(created.id);
                notify(`پروژه «${created.name}» ایجاد شد.`, 'success');
              }}
              onUpdateProjectTone={async (pid, tone, customPrompt) => {
                await api.updateProject(pid, {
                  defaultTone: tone,
                  customTonePrompt: customPrompt,
                });
                await loadCoreData(pid);
                notify('لحن پیش‌فرض پروژه ذخیره شد.', 'success');
              }}
              onDeleteProject={async (pid) => {
                await api.deleteProject(pid);
                await loadCoreData(null);
                notify('پروژه حذف شد.', 'info');
              }}
              onSetFolderTone={async (folderPath, tone, customPrompt) => {
                if (!activeProject) return;
                const updated = await api.setFolderTone(activeProject.id, {
                  folderPath,
                  tone,
                  customPrompt,
                });
                setFolderTones(updated);
                notify('لحن اختصاصی پوشه ذخیره شد.', 'success');
              }}
              onDeleteFolder={async (folderPath) => {
                if (!activeProject) return;
                const res = await api.deleteFolder(activeProject.id, folderPath);
                setSelectedFileId(null);
                await loadCoreData(activeProject.id);
                notify(
                  `پوشه «${folderPath || 'ریشه'}» به همراه ${res.deletedFiles} فایل زیرنویس حذف شد.`,
                  'info'
                );
              }}
              onSetFileTone={async (fileId, tone, customPrompt) => {
                await api.updateFile(fileId, {
                  toneOverride: tone,
                  customToneOverride: customPrompt,
                });
                await loadCoreData(activeProject?.id);
                notify('لحن اختصاصی فایل ذخیره شد.', 'success');
              }}
              onDeleteFile={async (fileId) => {
                await api.deleteFile(fileId);
                if (selectedFileId === fileId) setSelectedFileId(null);
                await loadCoreData(activeProject?.id);
                notify('فایل از پروژه حذف شد.', 'info');
              }}
              onBulkDeleteFiles={async (fileIds) => {
                const res = await api.bulkDeleteFiles(fileIds);
                if (selectedFileId && fileIds.includes(selectedFileId)) {
                  setSelectedFileId(null);
                }
                await loadCoreData(activeProject?.id);
                notify(`${res.deletedCount} فایل زیرنویس حذف شد.`, 'info');
              }}
              onImportFiles={handleImportFiles}
              onTranslateFiles={(ids, mode) => handleStartQueue(ids, mode)}
              onOpenEditor={handleOpenEditor}
              onNotify={notify}
            />
          )}

          {nav === 'editor' && (
            <EditorView
              projectId={activeProject?.id ?? null}
              files={files}
              selectedFileId={selectedFileId}
              onSelectFile={(fid) => setSelectedFileId(fid)}
              onStartSelective={(fid, mode, cueIds) =>
                handleStartQueue([fid], mode, cueIds)
              }
              onNotify={notify}
              refreshTick={refreshTick}
            />
          )}

          {nav === 'providers' && (
            <ProvidersView
              providers={providers}
              onRefresh={() => loadCoreData(activeProject?.id)}
              onNotify={notify}
            />
          )}

          {nav === 'glossary' && (
            <GlossaryView
              projectId={activeProject?.id ?? null}
              terms={glossary}
              onRefresh={() => loadCoreData(activeProject?.id)}
              onNotify={notify}
            />
          )}

          {nav === 'logs' && (
            <LogsView
              logs={logs}
              providers={providers}
              onRefresh={loadLogs}
              onNotify={notify}
            />
          )}

          {nav === 'settings' && (
            <SettingsDesktopView
              settings={settings}
              onSaveSettings={async (partial) => {
                const updated = await api.saveSettings(partial);
                setSettings(updated);
              }}
              onAfterRestore={() => loadCoreData(null)}
              onNotify={notify}
            />
          )}
        </main>
      </div>
    </div>
  );
}
