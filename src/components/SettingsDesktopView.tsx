import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  Download,
  HardDriveUpload,
  Save,
  Server,
  Terminal,
} from 'lucide-react';
import type { AppSettings } from '../shared/types.ts';
import { api } from '../lib/api.ts';

interface SettingsDesktopViewProps {
  settings: AppSettings;
  onSaveSettings: (partial: Partial<AppSettings>) => Promise<void>;
  onAfterRestore: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export function SettingsDesktopView({
  settings,
  onSaveSettings,
  onAfterRestore,
  onNotify,
}: SettingsDesktopViewProps) {
  const [form, setForm] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setForm(settings);
  }, [settings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSaveSettings(form);
      onNotify('تنظیمات پردازش موازی و ترجمه ذخیره شد.', 'success');
    } finally {
      setSaving(false);
    }
  };

  const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const res = await api.restoreBackup(parsed);
      await onAfterRestore();
      onNotify(
        `بازیابی با موفقیت انجام شد: ${res.projectsRestored} پروژه، ${res.filesRestored} فایل و ${res.cuesRestored} خط.`,
        'success'
      );
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'فایل پشتیبان معتبر نیست.',
        'error'
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* Parallel Engine & Context Settings */}
      <form
        onSubmit={handleSave}
        className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5"
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
              تنظیمات موتور ترجمه موازی، Batch Size و تکمیل خودکار
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              تمام تغییرات به صورت دائمی در دیتابیس SQLite ذخیره می‌شوند.
            </p>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'در حال ذخیره...' : 'ذخیره تنظیمات'}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div>
            <label className="block mb-1.5 font-medium text-slate-700 dark:text-slate-300">
              تعداد فایل‌های موازی همزمان (Concurrency: {form.maxConcurrentFiles})
            </label>
            <input
              type="range"
              min={1}
              max={8}
              value={form.maxConcurrentFiles}
              onChange={(e) =>
                setForm({ ...form, maxConcurrentFiles: Number(e.target.value) })
              }
              className="w-full"
            />
            <div className="mt-1 text-[11px] text-slate-500">
              هر کلید Gemini حداکثر ۱ درخواست همزمان و ≤۱۰ درخواست در دقیقه می‌فرستد
            </div>
          </div>

          <div>
            <label className="block mb-1.5 font-medium text-slate-700 dark:text-slate-300">
              تعداد ردیف در هر درخواست (Batch Size)
            </label>
            <input
              type="number"
              min={4}
              max={80}
              value={form.batchSize}
              onChange={(e) => setForm({ ...form, batchSize: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
            />
            <div className="mt-1 text-[11px] text-slate-500">
              پیش‌فرض: ۳۵ ردیف در هر بسته (قابل تغییر دستی از ۴ تا ۸۰ ردیف)
            </div>
          </div>

          <div>
            <label className="block mb-1.5 font-medium text-slate-700 dark:text-slate-300">
              حداکثر تلاش مجدد و Failover برای هر بسته
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={form.maxRetries}
              onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })}
              className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block mb-1.5 font-medium text-slate-700 dark:text-slate-300">
              خطوط Context قبلی (برای پیوستگی گفتگو)
            </label>
            <input
              type="number"
              min={0}
              max={10}
              value={form.contextBefore}
              onChange={(e) =>
                setForm({ ...form, contextBefore: Number(e.target.value) })
              }
              className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block mb-1.5 font-medium text-slate-700 dark:text-slate-300">
              خطوط Context بعدی (درک ادامه جمله)
            </label>
            <input
              type="number"
              min={0}
              max={10}
              value={form.contextAfter}
              onChange={(e) =>
                setForm({ ...form, contextAfter: Number(e.target.value) })
              }
              className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
            />
          </div>

          <div>
            <label className="block mb-1.5 font-medium text-slate-700 dark:text-slate-300">
              سقف انتظار APIهای واسط کند (ثانیه — تا ۹۰۰ ثانیه)
            </label>
            <input
              type="number"
              min={60}
              max={900}
              value={Math.round(form.adaptiveProxyTimeoutMs / 1000)}
              onChange={(e) =>
                setForm({
                  ...form,
                  adaptiveProxyTimeoutMs: Number(e.target.value) * 1000,
                })
              }
              className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
            />
            <div className="mt-1 text-[11px] text-slate-500">
              تمدید خودکار هنگام تأخیر + Keep-Alive استریم برای جلوگیری از Timeout زودهنگام
            </div>
          </div>
        </div>

        <div className="pt-2 flex flex-wrap gap-6 text-xs text-slate-700 dark:text-slate-300">
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.preserveHtmlTags}
              onChange={(e) =>
                setForm({ ...form, preserveHtmlTags: e.target.checked })
              }
            />
            حفظ تگ‌های قالب‌بندی زیرنویس (مانند {'<i>...</i>'})
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.autoRepairIncomplete}
              onChange={(e) =>
                setForm({ ...form, autoRepairIncomplete: e.target.checked })
              }
            />
            تکمیل خودکار ترجمه‌های ناقص، خالی یا انگلیسی‌مانده تا ۱۰۰٪ پیش از رفتن به فایل بعدی
          </label>
        </div>
      </form>

      {/* Database Backup & Restore */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <input
          ref={restoreInputRef}
          type="file"
          accept=".json"
          onChange={handleRestoreFile}
          className="hidden"
        />
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
              <Archive className="w-4 h-4 text-slate-500" />
              پشتیبان‌گیری و بازیابی کامل دیتابیس
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              از تمام پروژه‌ها، پوشه‌ها، خطوط زیرنویس، ترجمه‌های فارسی، تنظیمات لحن و واژه‌نامه فایل پشتیبان JSON تهیه کنید یا در هر زمان بازیابی نمایید.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <a
              href="/api/backup/export"
              download
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              دانلود پشتیبان کامل (JSON)
            </a>
            <button
              type="button"
              onClick={() => restoreInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
            >
              <HardDriveUpload className="w-3.5 h-3.5" />
              بازیابی از فایل پشتیبان
            </button>
          </div>
        </div>
      </div>

      {/* Node.js Localhost Execution Guide */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50 flex items-center gap-2">
            <Server className="w-4 h-4 text-blue-500" />
            اجرای محلی با Node.js روی Localhost
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            این برنامه کاملاً روی Node.js (نسخه ۲۲.۵ به بالا با SQLite داخلی) اجرا می‌شود و بدون نیاز به نصب دیتابیس یا نسخه EXE می‌توانید آن را روی کامپیوتر شخصی خود روی آدرس{' '}
            <span className="font-mono text-slate-700 dark:text-slate-200" dir="ltr">
              http://localhost:3000
            </span>{' '}
            بالا بیاورید.
          </p>
        </div>

        <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-900/70 border border-slate-200 dark:border-slate-800">
          <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 mb-2 flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5 text-slate-500" />
            دستورات نصب و اجرا روی Localhost
          </div>
          <pre
            dir="ltr"
            className="text-[11px] font-mono leading-5 text-slate-700 dark:text-slate-300 overflow-x-auto"
          >{`# 1. Install dependencies (Node.js 22.5+ required)
npm install

# 2. Run directly on http://localhost:3000
npm run dev

# 3. Or build & run in production mode
npm run build
npm start`}</pre>
        </div>
      </div>
    </div>
  );
}
