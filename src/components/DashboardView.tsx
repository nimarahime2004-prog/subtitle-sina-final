import React, { useRef, useState } from 'react';
import {
  Download,
  FileUp,
  FolderUp,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wrench,
} from 'lucide-react';
import type {
  ApiProvider,
  DashboardSummary,
  SubtitleFile,
} from '../shared/types.ts';
import { readSelectedSubtitleFiles } from '../lib/api.ts';

interface DashboardViewProps {
  summary: DashboardSummary | null;
  files: SubtitleFile[];
  providers: ApiProvider[];
  activeProjectId: number | null;
  onImportFiles: (items: Array<{ relativePath: string; content: string }>) => Promise<void>;
  onLoadSample: () => Promise<void>;
  onStartQueue: (fileIds: number[], mode: 'pending' | 'repair') => Promise<void>;
  onPauseQueue: () => Promise<void>;
  onResumeQueue: () => Promise<void>;
  onStopQueue: () => Promise<void>;
  onOpenEditor: (fileId: number) => void;
  onDeleteFile: (fileId: number) => Promise<void>;
  onExportAllZip: () => Promise<void>;
}

const FILE_STATUS_LABELS: Record<SubtitleFile['status'], { label: string; tone: string }> = {
  idle: { label: 'در انتظار شروع', tone: 'text-slate-500 dark:text-slate-400' },
  queued: { label: 'در صف ترجمه', tone: 'text-blue-600 dark:text-blue-400' },
  translating: { label: 'در حال ترجمه', tone: 'text-blue-600 dark:text-blue-400 font-semibold' },
  paused: { label: 'متوقف موقت', tone: 'text-amber-600 dark:text-amber-400' },
  completed: { label: 'تکمیل ۱۰۰٪', tone: 'text-emerald-600 dark:text-emerald-400 font-medium' },
  partial: { label: 'ناقص / نیمه‌تمام', tone: 'text-amber-600 dark:text-amber-400' },
  error: { label: 'دارای خطا', tone: 'text-red-600 dark:text-red-400 font-medium' },
};

export function DashboardView({
  summary,
  files,
  providers,
  activeProjectId,
  onImportFiles,
  onLoadSample,
  onStartQueue,
  onPauseQueue,
  onResumeQueue,
  onStopQueue,
  onOpenEditor,
  onDeleteFile,
  onExportAllZip,
}: DashboardViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const queue = summary?.queue;
  const isRunning = queue?.state === 'running';
  const isPaused = queue?.state === 'paused';

  const totalCues = files.reduce((s, f) => s + f.totalCues, 0);
  const completedCues = files.reduce((s, f) => s + f.completedCues, 0);
  const incompleteOrErrorCues = files.reduce(
    (s, f) => s + f.incompleteCues + f.errorCues,
    0
  );
  const overallPercent =
    totalCues > 0 ? Math.round((completedCues / totalCues) * 100) : 0;

  const pendingFileIds = files
    .filter((f) => f.completedCues < f.totalCues)
    .map((f) => f.id);
  const repairFileIds = files
    .filter((f) => f.incompleteCues > 0 || f.errorCues > 0 || f.completedCues < f.totalCues)
    .map((f) => f.id);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const items = await readSelectedSubtitleFiles(e.target.files);
    e.target.value = '';
    if (items.length > 0) {
      await onImportFiles(items);
    }
  };

  return (
    <div className="space-y-6">
      {/* Hidden native inputs for file & folder tree import */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".srt,.vtt"
        onChange={handleFileChange}
        className="hidden"
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is standard in Chromium/Edge/Firefox for folder tree import
        webkitdirectory=""
        directory=""
        onChange={handleFileChange}
        className="hidden"
      />

      {/* KPI Strip — 4-column flat structural row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            پیشرفت پروژه فعلی
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50">
              {overallPercent}%
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {completedCues.toLocaleString()} / {totalCues.toLocaleString()} خط
            </span>
          </div>
          <div className="mt-3 h-1.5 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${overallPercent}%` }}
            />
          </div>
        </div>

        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            فایل‌ها و خطوط نیازمند تکمیل
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50">
              {files.length.toLocaleString()}
            </span>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              فایل SRT / VTT
            </span>
          </div>
          <div className="mt-2.5 text-xs text-slate-500 dark:text-slate-400">
            <span>{incompleteOrErrorCues.toLocaleString()} خط ناقص یا خطادار</span>
            <span className="mx-1.5" aria-hidden="true">·</span>
            <span>ذخیره خودکار فعال</span>
          </div>
        </div>

        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            سرویس‌های API فعال
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50">
              {providers.filter((p) => p.enabled).length}
            </span>
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {summary?.avgLatencyMs ? `${summary.avgLatencyMs} ms میانگین` : 'آماده اتصال'}
            </span>
          </div>
          <div className="mt-2.5 text-xs text-slate-500 dark:text-slate-400 truncate">
            {providers.find((p) => p.enabled)?.name ?? 'بدون ارائه‌دهنده فعال'}
          </div>
        </div>

        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            مصرف کل توکن و برآورد هزینه
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-50">
              {(summary?.totalTokens ?? 0).toLocaleString()}
            </span>
            <span className="text-xs font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
              ${(summary?.estimatedCostUsd ?? 0).toFixed(4)}
            </span>
          </div>
          <div className="mt-2.5 text-xs text-slate-500 dark:text-slate-400">
            تضمین ۱۰۰٪ عدم تغییر Timecode
          </div>
        </div>
      </div>

      {/* Live Queue Control Bar */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
              کنترل صف ترجمه موازی و ورود سریع فایل‌ها
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              <span>وضعیت صف: </span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {isRunning
                  ? 'در حال ترجمه موازی'
                  : isPaused
                    ? 'متوقف موقت (قابل ادامه)'
                    : 'آماده به کار'}
              </span>
              <span className="mx-1.5" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {queue?.activeWorkers.length ?? 0} فایل در حال پردازش
              </span>
              <span className="mx-1.5" aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {queue?.queuedFileIds.length ?? 0} فایل در انتظار
              </span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!activeProjectId}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5" />
              ورود فایل SRT/VTT
            </button>
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={!activeProjectId}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FolderUp className="w-3.5 h-3.5" />
              ورود پوشه با ساختار
            </button>

            {!isRunning && !isPaused && (
              <button
                type="button"
                onClick={() => onStartQueue(pendingFileIds, 'pending')}
                disabled={pendingFileIds.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-45 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                شروع ترجمه گروهی ({pendingFileIds.length})
              </button>
            )}

            {isRunning && (
              <button
                type="button"
                onClick={onPauseQueue}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-700 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Pause className="w-3.5 h-3.5" />
                توقف موقت (Pause)
              </button>
            )}

            {isPaused && (
              <button
                type="button"
                onClick={onResumeQueue}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                ادامه ترجمه (Resume)
              </button>
            )}

            {(isRunning || isPaused) && (
              <button
                type="button"
                onClick={onStopQueue}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-red-300 dark:border-red-900/70 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5" />
                توقف کامل
              </button>
            )}

            {repairFileIds.length > 0 && !isRunning && (
              <button
                type="button"
                onClick={() => onStartQueue(repairFileIds, 'repair')}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Wrench className="w-3.5 h-3.5" />
                تکمیل موارد ناقص تا ۱۰۰٪
              </button>
            )}

            {files.length > 0 && (
              <button
                type="button"
                onClick={onExportAllZip}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                خروجی ZIP با پوشه‌ها
              </button>
            )}
          </div>
        </div>

        {/* Live Workers Indicator (only rendered when genuinely active) */}
        {queue && queue.activeWorkers.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2.5">
              پردازش‌های همزمان فعال (API و مدل هر فایل)
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {queue.activeWorkers.map((w) => (
                <div
                  key={w.fileId}
                  className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate font-en" dir="ltr">
                      {w.fileName}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1.5 flex-wrap">
                      <span>{w.providerName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono" dir="ltr">{w.modelName}</span>
                    </div>
                    {w.waitingNote && (
                      <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                        {w.waitingNote}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                    <span className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {w.batchProgress}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Files Overview Table or Honest Empty State */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
              وضعیت فایل‌های زیرنویس در پروژه فعلی
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              روی هر فایل کلیک کنید تا در ادیتور دوزبانه باز شود
            </p>
          </div>
          {files.length === 0 && (
            <button
              type="button"
              onClick={onLoadSample}
              className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              بارگذاری ۲ فایل نمونه SRT و VTT برای تست فوری
            </button>
          )}
        </div>

        {files.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="mx-auto w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center text-slate-500 dark:text-slate-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <h4 className="mt-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
              هنوز فایل زیرنویسی به این پروژه اضافه نشده است
            </h4>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto leading-relaxed">
              فایل‌های SRT یا VTT را به صورت تکی، گروهی یا یک پوشه کامل با حفظ ساختار زیرپوشه‌ها وارد کنید. زمان‌بندی (Timecode) فایل‌ها مستقل و ۱۰۰٪ دست‌نخورده ذخیره می‌شود.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer"
              >
                <FileUp className="w-3.5 h-3.5" />
                انتخاب فایل‌های زیرنویس
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                <FolderUp className="w-3.5 h-3.5" />
                وارد کردن پوشه کامل
              </button>
              <button
                type="button"
                onClick={onLoadSample}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
              >
                بارگذاری نمونه SRT و VTT
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-right border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4">مسیر و نام فایل</th>
                  <th className="py-3 px-4">فرمت</th>
                  <th className="py-3 px-4">پیشرفت</th>
                  <th className="py-3 px-4">وضعیت</th>
                  <th className="py-3 px-4">API / مدل فعال</th>
                  <th className="py-3 px-4 text-left">توکن</th>
                  <th className="py-3 px-4 text-left">عملیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
                {files.map((file) => {
                  const pct =
                    file.totalCues > 0
                      ? Math.round((file.completedCues / file.totalCues) * 100)
                      : 0;
                  const meta = FILE_STATUS_LABELS[file.status];
                  return (
                    <tr
                      key={file.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <button
                          type="button"
                          onClick={() => onOpenEditor(file.id)}
                          className="text-right hover:text-blue-600 dark:hover:text-blue-400 transition-colors cursor-pointer"
                        >
                          <div className="font-medium text-slate-900 dark:text-slate-100 font-en" dir="ltr">
                            {file.fileName}
                          </div>
                          {file.folderPath && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 font-en" dir="ltr">
                              {file.folderPath}
                            </div>
                          )}
                        </button>
                      </td>
                      <td className="py-3 px-4 font-mono uppercase text-slate-500 dark:text-slate-400">
                        {file.format}
                      </td>
                      <td className="py-3 px-4 min-w-[150px]">
                        <div className="flex items-center gap-2.5">
                          <div className="flex-1 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                pct === 100 ? 'bg-emerald-500' : 'bg-blue-600'
                              }`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="font-mono tabular-nums text-[11px] text-slate-600 dark:text-slate-300 w-10 text-left">
                            {pct}%
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                          {file.completedCues}/{file.totalCues}
                          {file.incompleteCues > 0 ? ` · ${file.incompleteCues} ناقص` : ''}
                          {file.errorCues > 0 ? ` · ${file.errorCues} خطا` : ''}
                        </div>
                      </td>
                      <td className={`py-3 px-4 whitespace-nowrap ${meta.tone}`}>
                        {meta.label}
                      </td>
                      <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                        {file.activeProviderName ? (
                          <div>
                            <div className="text-xs font-medium">{file.activeProviderName}</div>
                            <div className="text-[11px] font-mono text-slate-500" dir="ltr">
                              {file.activeModelName}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-400 dark:text-slate-500">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono tabular-nums text-left text-slate-600 dark:text-slate-300">
                        {file.totalTokens.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-left whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenEditor(file.id)}
                            className="text-blue-600 dark:text-blue-400 hover:underline font-medium cursor-pointer"
                          >
                            ویرایش
                          </button>
                          <span className="text-slate-300 dark:text-slate-700">·</span>
                          <button
                            type="button"
                            onClick={() => onStartQueue([file.id], 'pending')}
                            className="text-slate-700 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer"
                          >
                            ترجمه
                          </button>
                          <span className="text-slate-300 dark:text-slate-700">·</span>
                          {confirmDeleteId === file.id ? (
                            <>
                              <button
                                type="button"
                                onClick={async () => {
                                  await onDeleteFile(file.id);
                                  setConfirmDeleteId(null);
                                }}
                                className="text-red-600 dark:text-red-400 font-semibold hover:underline cursor-pointer"
                              >
                                تایید حذف
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteId(null)}
                                className="text-slate-400 hover:text-slate-600 cursor-pointer"
                              >
                                لغو
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(file.id)}
                              className="text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer inline-flex items-center"
                              title="حذف زیرنویس"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
