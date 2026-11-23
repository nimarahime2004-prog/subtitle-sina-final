import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Download,
  Lock,
  Play,
  RefreshCw,
  Replace,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import type {
  FindReplaceMatch,
  SubtitleCue,
  SubtitleFile,
} from '../shared/types.ts';
import { api } from '../lib/api.ts';

interface EditorViewProps {
  projectId: number | null;
  files: SubtitleFile[];
  selectedFileId: number | null;
  onSelectFile: (fileId: number) => void;
  onStartSelective: (
    fileId: number,
    mode: 'pending' | 'repair' | 'selective',
    selectedCueIds?: number[]
  ) => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
  refreshTick: number;
}

type CueFilter = 'all' | 'done' | 'issues' | 'pending' | 'edited';

export function EditorView({
  projectId,
  files,
  selectedFileId,
  onSelectFile,
  onStartSelective,
  onNotify,
  refreshTick,
}: EditorViewProps) {
  const [fileMeta, setFileMeta] = useState<SubtitleFile | null>(null);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<CueFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [savingCueIds, setSavingCueIds] = useState<Set<number>>(new Set());
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Map<number, string>>(new Map());

  // Exact Find & Replace panel
  const [showFindReplace, setShowFindReplace] = useState(false);
  const [frScope, setFrScope] = useState<'file' | 'folder' | 'project'>('file');
  const [frFind, setFrFind] = useState('');
  const [frReplace, setFrReplace] = useState('');
  const [frWholeWord, setFrWholeWord] = useState(true);
  const [frCaseSensitive, setFrCaseSensitive] = useState(false);
  const [frMatches, setFrMatches] = useState<FindReplaceMatch[]>([]);
  const [frStats, setFrStats] = useState<{ total: number; files: number } | null>(null);

  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const effectiveFileId = selectedFileId ?? files[0]?.id ?? null;

  const loadCues = useCallback(async (fid: number, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.getFileCues(fid);
      setFileMeta(data.file);
      setCues(data.cues);
    } catch (err) {
      if (!silent) {
        onNotify(err instanceof Error ? err.message : 'خطا در بارگذاری زیرنویس', 'error');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    if (effectiveFileId) {
      setSelectedIds(new Set());
      setDrafts(new Map());
      void loadCues(effectiveFileId, false);
    } else {
      setFileMeta(null);
      setCues([]);
    }
  }, [effectiveFileId, loadCues]);

  // Refresh silently during live queue translation updates
  useEffect(() => {
    if (effectiveFileId && refreshTick > 0) {
      void loadCues(effectiveFileId, true);
    }
  }, [effectiveFileId, refreshTick, loadCues]);

  const handleEditChange = (cueId: number, value: string) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(cueId, value);
      return next;
    });

    const existingTimer = timersRef.current.get(cueId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
      setSavingCueIds((s) => new Set(s).add(cueId));
      try {
        const res = await api.saveCue(cueId, value);
        setCues((curr) => curr.map((c) => (c.id === cueId ? res.cue : c)));
        if (res.file) setFileMeta(res.file);
        setLastSavedAt(new Date().toLocaleTimeString('fa-IR'));
        setDrafts((prev) => {
          const next = new Map(prev);
          if (next.get(cueId) === value) next.delete(cueId);
          return next;
        });
      } catch (err) {
        onNotify(err instanceof Error ? err.message : 'خطا در ذخیره خودکار', 'error');
      } finally {
        setSavingCueIds((s) => {
          const next = new Set(s);
          next.delete(cueId);
          return next;
        });
      }
    }, 550);

    timersRef.current.set(cueId, timer);
  };

  const filteredCues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return cues.filter((c) => {
      if (filter === 'done' && c.status !== 'done' && c.status !== 'edited') return false;
      if (filter === 'edited' && c.status !== 'edited') return false;
      if (filter === 'pending' && c.status !== 'pending') return false;
      if (
        filter === 'issues' &&
        c.status !== 'incomplete' &&
        c.status !== 'error' &&
        c.qaIssues.length === 0
      ) {
        return false;
      }
      if (q) {
        const tr = (drafts.get(c.id) ?? c.translatedText).toLowerCase();
        return (
          c.sourceText.toLowerCase().includes(q) ||
          tr.includes(q) ||
          c.rawTimecodeLine.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [cues, filter, searchQuery, drafts]);

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAllVisible = () => {
    if (
      filteredCues.length > 0 &&
      filteredCues.every((c) => selectedIds.has(c.id))
    ) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredCues.map((c) => c.id)));
    }
  };

  const handleRunQa = async () => {
    if (!effectiveFileId) return;
    try {
      const res = await api.runQa(effectiveFileId);
      setCues(res.cues);
      if (res.file) setFileMeta(res.file);
      onNotify(
        res.flaggedCount > 0
          ? `بررسی کیفیت انجام شد: ${res.flaggedCount} خط ناقص یا دارای هشدار پیدا شد.`
          : 'بررسی کیفیت انجام شد: تمام خطوط ترجمه‌شده سالم هستند.',
        res.flaggedCount > 0 ? 'info' : 'success'
      );
      if (res.flaggedCount > 0) setFilter('issues');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در بررسی کیفیت', 'error');
    }
  };

  const handleVerifyIntegrity = async () => {
    if (!effectiveFileId) return;
    const report = await api.verifyIntegrity(effectiveFileId);
    onNotify(
      report.valid
        ? `تایید ۱۰۰٪ صحت Timecode: تمام ${report.exportedCount} خط کاملاً دست‌نخورده باقی مانده‌اند.`
        : `عدم تطابق در ${report.mismatches.length} خط یافت شد.`,
      report.valid ? 'success' : 'error'
    );
  };

  const handlePreviewFR = async () => {
    if (!projectId || !frFind) return;
    try {
      const res = await api.previewFindReplace({
        projectId,
        scope: frScope,
        fileId: effectiveFileId ?? undefined,
        folderPath: fileMeta?.folderPath ?? '',
        findText: frFind,
        replaceText: frReplace,
        wholeWord: frWholeWord,
        caseSensitive: frCaseSensitive,
      });
      setFrMatches(res.matches);
      setFrStats({ total: res.totalOccurrences, files: res.affectedFiles });
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در پیش‌نمایش جستجو', 'error');
    }
  };

  const handleApplyFR = async () => {
    if (!projectId || !frFind) return;
    try {
      const res = await api.applyFindReplace({
        projectId,
        scope: frScope,
        fileId: effectiveFileId ?? undefined,
        folderPath: fileMeta?.folderPath ?? '',
        findText: frFind,
        replaceText: frReplace,
        wholeWord: frWholeWord,
        caseSensitive: frCaseSensitive,
      });
      onNotify(
        `${res.totalOccurrences} مورد دقیق در ${res.updatedCues} خط و ${res.affectedFiles} فایل جایگزین شد.`,
        'success'
      );
      setFrMatches([]);
      setFrStats(null);
      if (effectiveFileId) await loadCues(effectiveFileId, true);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در جایگزینی', 'error');
    }
  };

  if (files.length === 0) {
    return (
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
          برای استفاده از ادیتور دوزبانه ابتدا حداقل یک فایل SRT یا VTT وارد پروژه کنید.
        </p>
      </div>
    );
  }

  const issueCount = cues.filter(
    (c) => c.status === 'incomplete' || c.status === 'error' || c.qaIssues.length > 0
  ).length;
  const pct =
    fileMeta && fileMeta.totalCues > 0
      ? Math.round((fileMeta.completedCues / fileMeta.totalCues) * 100)
      : 0;

  return (
    <div className="space-y-4">
      {/* Editor Toolbar */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <select
              value={effectiveFileId ?? ''}
              onChange={(e) => onSelectFile(Number(e.target.value))}
              className="px-3 py-2 text-xs font-medium rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 max-w-xs font-en"
              dir="ltr"
            >
              {files.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.relativePath}
                </option>
              ))}
            </select>

            {fileMeta && (
              <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2 font-mono tabular-nums">
                <span className="uppercase">{fileMeta.format}</span>
                <span>·</span>
                <span>
                  {fileMeta.completedCues}/{fileMeta.totalCues} ({pct}%)
                </span>
                {lastSavedAt && (
                  <>
                    <span>·</span>
                    <span className="text-emerald-600 dark:text-emerald-400 font-sans">
                      ذخیره خودکار {lastSavedAt}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectedIds.size > 0 && effectiveFileId && (
              <button
                type="button"
                onClick={() =>
                  onStartSelective(effectiveFileId, 'selective', Array.from(selectedIds))
                }
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                ترجمه مجدد انتخابی ({selectedIds.size})
              </button>
            )}

            {effectiveFileId && (
              <>
                <button
                  type="button"
                  onClick={() => onStartSelective(effectiveFileId, 'repair')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  تکمیل ناقص‌ها تا ۱۰۰٪
                </button>
                <button
                  type="button"
                  onClick={handleRunQa}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <AlertTriangle className="w-3.5 h-3.5" />
                  اسکن کیفیت ({issueCount})
                </button>
                <button
                  type="button"
                  onClick={() => setShowFindReplace((s) => !s)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap ${
                    showFindReplace
                      ? 'bg-blue-600/10 border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <Replace className="w-3.5 h-3.5" />
                  Find & Replace دقیق
                </button>
                <button
                  type="button"
                  onClick={handleVerifyIntegrity}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
                  تایید Timecode
                </button>
                <a
                  href={api.exportSingleFileUrl(effectiveFileId, false)}
                  download
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  خروجی {fileMeta?.format.toUpperCase()}
                </a>
              </>
            )}
          </div>
        </div>

        {/* Filter & Search Row */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg overflow-x-auto">
            {(
              [
                ['all', `همه (${cues.length})`],
                ['done', 'تکمیل‌شده'],
                ['issues', `ناقص و خطا (${issueCount})`],
                ['pending', 'در انتظار'],
                ['edited', 'ویرایش‌شده'],
              ] as Array<[CueFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filter === key
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative sm:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="جستجو در متن انگلیسی، فارسی یا زمان..."
              className="w-full pr-9 pl-3 py-1.5 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            />
          </div>
        </div>
      </div>

      {/* Exact Find & Replace Drawer */}
      {showFindReplace && (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                جستجو و جایگزینی دقیق (Unicode Whole-Word) — بدون تغییر ناخواسته کلمات مشابه
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                با فعال بودن «تطابق دقیق کلمه کامل»، جایگزینی «کار» هرگز کلماتی مانند «کاربر» یا «همکار» را تغییر نمی‌دهد.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowFindReplace(false)}
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-2.5">
            <input
              type="text"
              value={frFind}
              onChange={(e) => setFrFind(e.target.value)}
              placeholder="عبارت جستجو در ترجمه فارسی..."
              className="px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            />
            <input
              type="text"
              value={frReplace}
              onChange={(e) => setFrReplace(e.target.value)}
              placeholder="عبارت جایگزین..."
              className="px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            />
            <select
              value={frScope}
              onChange={(e) => setFrScope(e.target.value as 'file' | 'folder' | 'project')}
              className="px-3 py-2 text-xs rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
            >
              <option value="file">محدوده: فقط فایل فعلی</option>
              <option value="folder">محدوده: پوشه فعلی و زیرپوشه‌ها</option>
              <option value="project">محدوده: کل پروژه</option>
            </select>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePreviewFR}
                className="flex-1 px-3 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              >
                پیش‌نمایش
              </button>
              <button
                type="button"
                onClick={handleApplyFR}
                className="flex-1 px-3 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
              >
                اعمال جایگزینی
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={frWholeWord}
                onChange={(e) => setFrWholeWord(e.target.checked)}
              />
              تطابق دقیق کلمه کامل (پیشنهادی)
            </label>
            <label className="inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={frCaseSensitive}
                onChange={(e) => setFrCaseSensitive(e.target.checked)}
              />
              حساس به حروف بزرگ و کوچک
            </label>
            {frStats && (
              <span className="text-blue-600 dark:text-blue-400 font-medium">
                {frStats.total} مورد منطبق در {frStats.files} فایل یافت شد
              </span>
            )}
          </div>

          {frMatches.length > 0 && (
            <div className="max-h-48 overflow-y-auto border border-slate-200 dark:border-slate-800 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {frMatches.slice(0, 40).map((m) => (
                <div key={m.cueId} className="px-3 py-2 grid grid-cols-1 md:grid-cols-12 gap-2">
                  <div className="md:col-span-3 font-mono text-[11px] text-slate-500 truncate" dir="ltr">
                    {m.fileName} #{m.cueIndex + 1}
                  </div>
                  <div className="md:col-span-4 text-slate-500 line-through">
                    {m.beforeText}
                  </div>
                  <div className="md:col-span-5 text-emerald-600 dark:text-emerald-400 font-medium">
                    {m.afterText}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Dual-Language Side-by-Side Subtitle Grid */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-3 w-10 text-center">
                  <input
                    type="checkbox"
                    checked={
                      filteredCues.length > 0 &&
                      filteredCues.every((c) => selectedIds.has(c.id))
                    }
                    onChange={toggleSelectAllVisible}
                    title="انتخاب همه خطوط نمایش‌داده‌شده"
                  />
                </th>
                <th className="py-3 px-3 w-52">
                  <span className="inline-flex items-center gap-1">
                    <Lock className="w-3 h-3 text-emerald-500" />
                    Timecode (قفل‌شده ۱۰۰٪)
                  </span>
                </th>
                <th className="py-3 px-4 w-[38%]">متن اصلی انگلیسی</th>
                <th className="py-3 px-4 w-[42%]">ترجمه فارسی (ویرایش مستقیم با ذخیره خودکار)</th>
                <th className="py-3 px-3 w-20 text-center">عملیات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    در حال بارگذاری خطوط زیرنویس...
                  </td>
                </tr>
              ) : filteredCues.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-slate-500">
                    خطی مطابق فیلتر فعلی یافت نشد.
                  </td>
                </tr>
              ) : (
                filteredCues.map((cue) => {
                  const val = drafts.get(cue.id) ?? cue.translatedText;
                  const isSaving = savingCueIds.has(cue.id);
                  const hasIssues =
                    cue.qaIssues.length > 0 ||
                    cue.status === 'incomplete' ||
                    cue.status === 'error';
                  return (
                    <tr
                      key={cue.id}
                      className={`align-top transition-colors ${
                        selectedIds.has(cue.id)
                          ? 'bg-blue-50/60 dark:bg-blue-950/20'
                          : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/25'
                      }`}
                    >
                      <td className="py-3 px-3 text-center">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(cue.id)}
                          onChange={() => toggleSelect(cue.id)}
                        />
                        <div className="mt-1 font-mono tabular-nums text-[10px] text-slate-400">
                          {cue.cueIdentifier || cue.cueIndex + 1}
                        </div>
                      </td>

                      <td className="py-3 px-3">
                        <div
                          className="font-mono text-[11px] text-slate-600 dark:text-slate-300 leading-5 select-all"
                          dir="ltr"
                        >
                          {cue.rawTimecodeLine}
                        </div>
                        <div className="mt-1 text-[10px] text-slate-400">
                          {cue.status === 'translating' && (
                            <span className="text-blue-500">در حال ترجمه...</span>
                          )}
                          {cue.status === 'done' && (
                            <span className="text-emerald-600 dark:text-emerald-400">ترجمه‌شده</span>
                          )}
                          {cue.status === 'edited' && (
                            <span className="text-blue-600 dark:text-blue-400">ویرایش دستی</span>
                          )}
                          {cue.status === 'pending' && <span>در انتظار</span>}
                          {cue.status === 'incomplete' && (
                            <span className="text-amber-600 dark:text-amber-400">ناقص</span>
                          )}
                          {cue.status === 'error' && (
                            <span className="text-red-600 dark:text-red-400">خطا</span>
                          )}
                          {cue.modelUsed && (
                            <span className="block font-mono truncate max-w-[180px]" dir="ltr">
                              {cue.modelUsed}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <div
                          className="font-en text-xs leading-6 text-slate-800 dark:text-slate-200 whitespace-pre-wrap text-left"
                          dir="ltr"
                        >
                          {cue.sourceText}
                        </div>
                      </td>

                      <td className="py-3 px-4">
                        <textarea
                          rows={Math.max(2, cue.sourceText.split('\n').length)}
                          value={val}
                          onChange={(e) => handleEditChange(cue.id, e.target.value)}
                          placeholder="ترجمه فارسی این خط..."
                          className={`w-full px-3 py-2 text-xs leading-6 rounded-lg bg-slate-50 dark:bg-slate-900/90 border transition-colors resize-y text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${
                            hasIssues
                              ? 'border-amber-400 dark:border-amber-700'
                              : 'border-slate-200 dark:border-slate-700/80'
                          }`}
                        />
                        {hasIssues && cue.qaIssues.length > 0 && (
                          <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                            {cue.qaIssues.map((i) => i.messageFa).join(' · ')}
                          </div>
                        )}
                      </td>

                      <td className="py-3 px-3 text-center">
                        <div className="flex flex-col items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              effectiveFileId &&
                              onStartSelective(effectiveFileId, 'selective', [cue.id])
                            }
                            className="p-1.5 rounded-md text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                            title="ترجمه مجدد همین خط"
                          >
                            <Play className="w-3.5 h-3.5" />
                          </button>
                          {isSaving ? (
                            <RefreshCw className="w-3.5 h-3.5 text-blue-500 animate-spin" />
                          ) : cue.status === 'done' || cue.status === 'edited' ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Check className="w-3.5 h-3.5 text-slate-300 dark:text-slate-700" />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
