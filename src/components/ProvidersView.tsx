import React, { useState } from 'react';
import {
  Activity,
  DownloadCloud,
  Layers,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type { ApiProvider, ProviderType } from '../shared/types.ts';
import { api } from '../lib/api.ts';

interface ProvidersViewProps {
  providers: ApiProvider[];
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const PROVIDER_META: Record<
  ProviderType,
  { label: string; defaultUrl: string; defaultModel: string; defaultRpm: number }
> = {
  gemini_builtin: {
    label: 'Gemini داخلی سرور (آماده به کار)',
    defaultUrl: '',
    defaultModel: 'gemini-3.5-flash-lite',
    defaultRpm: 10,
  },
  gemini: {
    label: 'Google Gemini (کلید اختصاصی)',
    defaultUrl: '',
    defaultModel: 'gemini-3.5-flash-lite',
    defaultRpm: 10,
  },
  openai: {
    label: 'OpenAI',
    defaultUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    defaultRpm: 20,
  },
  deepseek: {
    label: 'DeepSeek',
    defaultUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    defaultRpm: 20,
  },
  openrouter: {
    label: 'OpenRouter',
    defaultUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-2.5-flash',
    defaultRpm: 15,
  },
  custom_proxy: {
    label: 'API واسط / پروکسی سازگار با OpenAI',
    defaultUrl: 'https://api.openai.com/v1',
    defaultModel: 'gemini-3.5-flash-lite',
    defaultRpm: 15,
  },
};

interface MixedBulkRow {
  rowId: number;
  providerType: ProviderType;
  name: string;
  baseUrl: string;
  apiKey: string;
  modelName: string;
  rpmLimit: number;
  timeoutSec: number;
}

function createMixedRow(rowId: number, type: ProviderType = 'gemini'): MixedBulkRow {
  const meta = PROVIDER_META[type];
  return {
    rowId,
    providerType: type,
    name: `${type.toUpperCase()} #${rowId}`,
    baseUrl: meta.defaultUrl,
    apiKey: '',
    modelName: meta.defaultModel,
    rpmLimit: meta.defaultRpm,
    timeoutSec: 300,
  };
}

export function ProvidersView({
  providers,
  onRefresh,
  onNotify,
}: ProvidersViewProps) {
  const [mode, setMode] = useState<'none' | 'single' | 'bulk'>('none');
  const [bulkTab, setBulkTab] = useState<'gemini_quick' | 'mixed' | 'same_provider' | 'paste_lines'>('gemini_quick');
  const [testingId, setTestingId] = useState<number | null>(null);
  const [fetchingModelsId, setFetchingModelsId] = useState<number | null>(null);
  const [testReplies, setTestReplies] = useState<
    Record<number, { ok: boolean; latencyMs: number; tokensUsed: number; modelUsed?: string; fallbackFromModel?: string; reply?: string; error?: string }>
  >({});

  // Dedicated Gemini-only quick bulk paste state
  const [geminiQuickKeys, setGeminiQuickKeys] = useState('');
  const [geminiQuickPrefix, setGeminiQuickPrefix] = useState('GEMINI');
  const [geminiQuickRpm, setGeminiQuickRpm] = useState(10);

  // Single add form state
  const [providerType, setProviderType] = useState<ProviderType>('gemini');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState(PROVIDER_META.gemini.defaultUrl);
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState(PROVIDER_META.gemini.defaultModel);
  const [priority, setPriority] = useState(10);
  const [rpmLimit, setRpmLimit] = useState(10);
  const [tpmLimit, setTpmLimit] = useState(120000);
  const [timeoutSec, setTimeoutSec] = useState(300);

  // Same-provider multi-key bulk form state
  const [bulkType, setBulkType] = useState<ProviderType>('gemini');
  const [bulkPrefix, setBulkPrefix] = useState('GEMINI');
  const [bulkBaseUrl, setBulkBaseUrl] = useState('');
  const [bulkModel, setBulkModel] = useState('gemini-3.5-flash-lite');
  const [bulkRpm, setBulkRpm] = useState(10);
  const [bulkTimeoutSec, setBulkTimeoutSec] = useState(300);
  const [bulkKeys, setBulkKeys] = useState('');

  const detectedGeminiKeysCount = Array.from(
    new Set(
      geminiQuickKeys
        .split(/[\r\n,;]+/)
        .map((l) => l.trim().replace(/^["']|["']$/g, ''))
        .filter((l) => l.length >= 8 && !l.startsWith('#'))
    )
  ).length;

  // Mixed multi-provider table state
  const [mixedRows, setMixedRows] = useState<MixedBulkRow[]>([
    createMixedRow(1, 'gemini'),
    createMixedRow(2, 'custom_proxy'),
    createMixedRow(3, 'deepseek'),
  ]);
  const [pasteText, setPasteText] = useState('');

  const handleTypeChange = (t: ProviderType) => {
    setProviderType(t);
    setBaseUrl(PROVIDER_META[t].defaultUrl);
    setModelName(PROVIDER_META[t].defaultModel);
    setRpmLimit(PROVIDER_META[t].defaultRpm);
  };

  const handleBulkTypeChange = (t: ProviderType) => {
    setBulkType(t);
    setBulkBaseUrl(PROVIDER_META[t].defaultUrl);
    setBulkModel(PROVIDER_META[t].defaultModel);
    setBulkRpm(PROVIDER_META[t].defaultRpm);
    setBulkPrefix(t === 'gemini' ? 'Gemini Pool' : t === 'custom_proxy' ? 'Proxy Pool' : t.toUpperCase());
  };

  const handleAddSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api.createProvider({
        name: name.trim(),
        providerType,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelName: modelName.trim(),
        priority,
        rpmLimit,
        tpmLimit,
        timeoutMs: timeoutSec * 1000,
      });
      setName('');
      setApiKey('');
      setMode('none');
      await onRefresh();
      onNotify('ارائه‌دهنده API جدید با کنترل ایمن RPM و سقف انتظار بالا اضافه شد.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در افزودن API', 'error');
    }
  };

  const handleGeminiQuickBulk = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!geminiQuickKeys.trim()) return;
    try {
      const safeRpm = Math.min(10, Math.max(1, geminiQuickRpm || 10));
      const res = await api.bulkImportProviders({
        providerType: 'gemini',
        namePrefix: geminiQuickPrefix.trim() || 'GEMINI',
        baseUrl: '',
        modelName: 'gemini-3.5-flash-lite',
        keysText: geminiQuickKeys,
        priorityStart: 5,
        rpmLimit: safeRpm,
        tpmLimit: 200000,
        timeoutMs: 300000,
      });
      setGeminiQuickKeys('');
      setMode('none');
      await onRefresh();
      onNotify(
        `${res.count} کلید Gemini روی مدل gemini-3.5-flash-lite (سقف ${safeRpm} RPM + سوئیچ خودکار به 3.1-flash-lite) ثبت شد${res.skippedDuplicates ? ` (${res.skippedDuplicates} تکراری رد شد)` : ''}.`,
        'success'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در ثبت گروهی کلیدهای Gemini', 'error');
    }
  };

  const handleBulkSameProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bulkKeys.trim()) return;
    try {
      const res = await api.bulkImportProviders({
        providerType: bulkType,
        namePrefix: bulkPrefix.trim(),
        baseUrl: bulkBaseUrl.trim(),
        modelName: bulkModel.trim(),
        keysText: bulkKeys,
        priorityStart: 10,
        rpmLimit: bulkType === 'gemini' ? Math.min(10, bulkRpm) : bulkRpm,
        tpmLimit: 120000,
        timeoutMs: bulkTimeoutSec * 1000,
      });
      setBulkKeys('');
      setMode('none');
      await onRefresh();
      onNotify(`${res.count} کلید API به صورت یکجا با فاصله‌گذاری ایمن RPM وارد صف شد.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در ورود گروهی کلیدها', 'error');
    }
  };

  const handleMixedRowChange = (
    rowId: number,
    patch: Partial<MixedBulkRow>
  ) => {
    setMixedRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        if (patch.providerType && patch.providerType !== r.providerType) {
          const meta = PROVIDER_META[patch.providerType];
          return {
            ...r,
            ...patch,
            baseUrl: meta.defaultUrl,
            modelName: meta.defaultModel,
            rpmLimit: meta.defaultRpm,
          };
        }
        return { ...r, ...patch };
      })
    );
  };

  const handleSubmitMixedRows = async (e: React.FormEvent) => {
    e.preventDefault();
    const valid = mixedRows.filter(
      (r) => r.apiKey.trim().length > 0 || r.providerType === 'custom_proxy'
    );
    if (valid.length === 0) {
      onNotify('حداقل در یک ردیف کلید API وارد کنید.', 'error');
      return;
    }
    try {
      const res = await api.bulkImportMixedProviders(
        valid.map((r, i) => ({
          name: r.name.trim() || `${r.providerType.toUpperCase()} #${i + 1}`,
          providerType: r.providerType,
          baseUrl: r.baseUrl.trim(),
          apiKey: r.apiKey.trim(),
          modelName: r.modelName.trim(),
          priority: 10 + i,
          rpmLimit: r.rpmLimit,
          timeoutMs: r.timeoutSec * 1000,
        }))
      );
      setMixedRows([createMixedRow(1, 'gemini'), createMixedRow(2, 'custom_proxy')]);
      setMode('none');
      await onRefresh();
      onNotify(`${res.count} سرویس API مختلف به صورت یکجا اضافه و آماده Failover شدند.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در ثبت گروهی APIها', 'error');
    }
  };

  const handleSubmitPasteLines = async (e: React.FormEvent) => {
    e.preventDefault();
    const raw = pasteText.trim();
    if (!raw) return;

    try {
      let items: Array<{
        name?: string;
        providerType: ProviderType;
        baseUrl?: string;
        apiKey?: string;
        modelName?: string;
        rpmLimit?: number;
        timeoutMs?: number;
      }> = [];

      if (raw.startsWith('[')) {
        const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
        items = parsed.map((obj, idx) => ({
          providerType: (String(obj.providerType || obj.type || 'custom_proxy') as ProviderType),
          name: String(obj.name || `API #${idx + 1}`),
          baseUrl: String(obj.baseUrl || obj.url || ''),
          apiKey: String(obj.apiKey || obj.key || ''),
          modelName: String(obj.modelName || obj.model || ''),
          rpmLimit: obj.rpmLimit ? Number(obj.rpmLimit) : undefined,
          timeoutMs: obj.timeoutSec ? Number(obj.timeoutSec) * 1000 : 300000,
        }));
      } else {
        const lines = raw
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
        items = lines.map((line, idx) => {
          const parts = line.split('|').map((p) => p.trim());
          // Format: type | name | baseUrl | apiKey | model | rpm | timeoutSec
          const rawType = (parts[0] || 'gemini').toLowerCase();
          const pType: ProviderType =
            rawType === 'gemini' ||
            rawType === 'openai' ||
            rawType === 'deepseek' ||
            rawType === 'openrouter' ||
            rawType === 'custom_proxy'
              ? rawType
              : 'custom_proxy';
          return {
            providerType: pType,
            name: parts[1] || `${pType.toUpperCase()} #${idx + 1}`,
            baseUrl: parts[2] || PROVIDER_META[pType].defaultUrl,
            apiKey: parts[3] || '',
            modelName: parts[4] || PROVIDER_META[pType].defaultModel,
            rpmLimit: parts[5] ? Number(parts[5]) : PROVIDER_META[pType].defaultRpm,
            timeoutMs: parts[6] ? Number(parts[6]) * 1000 : 300000,
          };
        });
      }

      const res = await api.bulkImportMixedProviders(items);
      setPasteText('');
      setMode('none');
      await onRefresh();
      onNotify(`${res.count} سرویس API از متن/JSON به صورت یکجا ثبت شدند.`, 'success');
    } catch (err) {
      onNotify(
        err instanceof Error ? err.message : 'فرمت متن یا JSON وارد شده معتبر نیست.',
        'error'
      );
    }
  };

  const handleTest = async (id: number) => {
    setTestingId(id);
    try {
      const res = await api.testProvider(id);
      setTestReplies((prev) => ({
        ...prev,
        [id]: {
          ok: res.result.ok,
          latencyMs: res.result.latencyMs,
          tokensUsed: res.result.tokensUsed,
          modelUsed: res.result.modelUsed,
          fallbackFromModel: res.result.fallbackFromModel,
          reply: res.result.sampleReply,
          error: res.result.error,
        },
      }));
      await onRefresh();
      onNotify(
        res.result.ok
          ? `تست موفق با ${res.result.modelUsed} (${res.result.latencyMs}ms · ${res.result.tokensUsed} توکن)${res.result.fallbackFromModel ? ` — سوئیچ خودکار از ${res.result.fallbackFromModel}` : ''}`
          : `تست ناموفق: ${res.result.error}`,
        res.result.ok ? 'success' : 'error'
      );
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در تست API', 'error');
    } finally {
      setTestingId(null);
    }
  };

  const handleFetchModels = async (id: number) => {
    setFetchingModelsId(id);
    try {
      const res = await api.fetchModels(id);
      await onRefresh();
      onNotify(`${res.models.length} مدل از سرور ارائه‌دهنده دریافت شد.`, 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'دریافت لیست مدل‌ها ناموفق بود', 'error');
    } finally {
      setFetchingModelsId(null);
    }
  };

  const handleQuickPatch = async (id: number, patch: Record<string, unknown>) => {
    try {
      await api.updateProvider(id, patch);
      await onRefresh();
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در به‌روزرسانی', 'error');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.deleteProvider(id);
      await onRefresh();
      onNotify('سرویس API حذف شد.', 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در حذف', 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Actions */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
            مدیریت APIها، سقف سخت‌گیرانه ۱۰ RPM جمنای و سوئیچ خودکار مدل
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            مدل پیش‌فرض <span className="font-mono text-slate-700 dark:text-slate-200">gemini-3.5-flash-lite</span> است و در صورت خطای 503 / شلوغی سرور به‌صورت خودکار روی <span className="font-mono text-slate-700 dark:text-slate-200">gemini-3.1-flash-lite</span> سوئیچ می‌شود. هر کلید Gemini حداکثر ۱۰ درخواست در دقیقه ارسال می‌کند تا قطع یا بلاک نشود.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setBulkTab('gemini_quick');
              setMode(mode === 'bulk' && bulkTab === 'gemini_quick' ? 'none' : 'bulk');
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer whitespace-nowrap"
          >
            <Layers className="w-3.5 h-3.5" />
            افزودن گروهی کلیدهای Gemini
          </button>
          <button
            type="button"
            onClick={() => {
              setBulkTab('mixed');
              setMode(mode === 'bulk' && bulkTab === 'mixed' ? 'none' : 'bulk');
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            چند API مختلف
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === 'single' ? 'none' : 'single')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            افزودن تکی
          </button>
        </div>
      </div>

      {/* Add Single Provider Form */}
      {mode === 'single' && (
        <form
          onSubmit={handleAddSingle}
          className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            اتصال سرویس هوش مصنوعی جدید
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 text-xs">
            <div>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">نوع سرویس</label>
              <select
                value={providerType}
                onChange={(e) => handleTypeChange(e.target.value as ProviderType)}
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              >
                <option value="gemini">Google Gemini (کلید مجزا)</option>
                <option value="custom_proxy">API واسط / پروکسی سفارشی</option>
                <option value="openai">OpenAI</option>
                <option value="deepseek">DeepSeek</option>
                <option value="openrouter">OpenRouter</option>
              </select>
            </div>
            <div>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">نام نمایشی</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً: Gemini کلید ۲ یا پروکسی واسط"
                className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
            </div>
            <div>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">نام مدل (یا ورود دستی)</label>
              <input
                type="text"
                required
                dir="ltr"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="gemini-3.5-flash-lite / gpt-4o-mini"
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
            </div>

            {providerType !== 'gemini' && (
              <div className="md:col-span-2">
                <label className="block mb-1 text-slate-500 dark:text-slate-400">
                  آدرس Base URL (پشتیبانی از APIهای واسط کند)
                </label>
                <input
                  type="url"
                  dir="ltr"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                />
              </div>
            )}

            <div className={providerType === 'gemini' ? 'md:col-span-3' : ''}>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">
                کلید اتصال سرویس (ذخیره سمت سرور)
              </label>
              <input
                type="password"
                dir="ltr"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="AIza... / sk-..."
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
            </div>

            <div>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">اولویت Failover (کمتر = اولویت بالاتر)</label>
              <input
                type="number"
                min={1}
                max={99}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
            </div>
            <div>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">
                سقف RPM در دقیقه (برای جمنای ۸ تا ۱۲ توصیه می‌شود)
              </label>
              <input
                type="number"
                min={1}
                max={500}
                value={rpmLimit}
                onChange={(e) => setRpmLimit(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
            </div>
            <div>
              <label className="block mb-1 text-slate-500 dark:text-slate-400">
                سقف انتظار پاسخ (ثانیه — تا ۹۰۰ ثانیه برای واسط کند)
              </label>
              <input
                type="number"
                min={60}
                max={900}
                value={timeoutSec}
                onChange={(e) => setTimeoutSec(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
            >
              ذخیره در صف APIها
            </button>
            <button
              type="button"
              onClick={() => setMode('none')}
              className="px-4 py-2 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 cursor-pointer"
            >
              انصراف
            </button>
          </div>
        </form>
      )}

      {/* Upgraded Bulk Import Panel: Dedicated Gemini Quick Paste + Mixed Multi-API Table + Same Provider + Paste Lines/JSON */}
      {mode === 'bulk' && (
        <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                ورود گروهی و یکجای کلیدها و سرویس‌های API
              </h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                لیست کلیدهای Gemini را مستقیم خط‌به‌خط Paste کنید (مثل <code className="font-mono" dir="ltr">AQ....</code> یا <code className="font-mono" dir="ltr">AIza...</code>)؛ همه خودکار روی <code className="font-mono" dir="ltr">gemini-3.5-flash-lite</code> و سقف ≤۱۰ RPM ثبت می‌شوند.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg shrink-0 overflow-x-auto">
              <button
                type="button"
                onClick={() => setBulkTab('gemini_quick')}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  bulkTab === 'gemini_quick'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                فقط کلیدهای Gemini (سریع)
              </button>
              <button
                type="button"
                onClick={() => setBulkTab('mixed')}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  bulkTab === 'mixed'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                جدول چند API مختلف
              </button>
              <button
                type="button"
                onClick={() => setBulkTab('same_provider')}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  bulkTab === 'same_provider'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                سایر سرویس‌ها (چند کلید)
              </button>
              <button
                type="button"
                onClick={() => setBulkTab('paste_lines')}
                className={`px-3 py-1.5 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  bulkTab === 'paste_lines'
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                ورود متنی / JSON
              </button>
            </div>
          </div>

          {bulkTab === 'gemini_quick' && (
            <form onSubmit={handleGeminiQuickBulk} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <div>
                  <label className="block mb-1 text-[11px] text-slate-500 dark:text-slate-400">
                    پیشوند نام کلیدها
                  </label>
                  <input
                    type="text"
                    value={geminiQuickPrefix}
                    onChange={(e) => setGeminiQuickPrefix(e.target.value)}
                    placeholder="GEMINI"
                    className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                  />
                </div>
                <div>
                  <label className="block mb-1 text-[11px] text-slate-500 dark:text-slate-400">
                    مدل اصلی و جایگزین خودکار
                  </label>
                  <div className="px-3 py-2 rounded-lg font-mono bg-slate-100 dark:bg-slate-800/70 text-slate-700 dark:text-slate-200 truncate" dir="ltr">
                    gemini-3.5-flash-lite → 3.1
                  </div>
                </div>
                <div>
                  <label className="block mb-1 text-[11px] text-slate-500 dark:text-slate-400">
                    سقف درخواست در دقیقه هر کلید (حداکثر ۱۰)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={geminiQuickRpm}
                    onChange={(e) =>
                      setGeminiQuickRpm(Math.min(10, Math.max(1, Number(e.target.value) || 10)))
                    }
                    className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                  />
                </div>
                <div className="flex items-end">
                  <div className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800/70 text-slate-700 dark:text-slate-300 font-mono tabular-nums">
                    {detectedGeminiKeysCount} کلید یکتا شناسایی شد
                  </div>
                </div>
              </div>

              <textarea
                rows={7}
                dir="ltr"
                required
                value={geminiQuickKeys}
                onChange={(e) => setGeminiQuickKeys(e.target.value)}
                placeholder={'AQ.Ab8RN6...\nAQ.Ab8RN6...\nAIzaSy...\n(هر کلید Gemini در یک خط)'}
                className="w-full px-3 py-2.5 rounded-lg font-mono leading-5 bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  کلیدهای تکراری به‌صورت خودکار حذف می‌شوند و بین همه کلیدها توزیع موازی (Round-Robin) انجام می‌گیرد.
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('none')}
                    className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                  >
                    انصراف
                  </button>
                  <button
                    type="submit"
                    disabled={detectedGeminiKeysCount === 0}
                    className="px-4 py-2 font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-45 text-white cursor-pointer"
                  >
                    افزودن {detectedGeminiKeysCount > 0 ? `${detectedGeminiKeysCount} کلید` : 'همه کلیدهای'} Gemini
                  </button>
                </div>
              </div>
            </form>
          )}

          {bulkTab === 'mixed' && (
            <form onSubmit={handleSubmitMixedRows} className="space-y-3">
              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                <table className="w-full text-right border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/60">
                      <th className="py-2 px-2">نوع سرویس</th>
                      <th className="py-2 px-2">نام نمایشی</th>
                      <th className="py-2 px-2">Base URL (برای واسط)</th>
                      <th className="py-2 px-2">کلید API</th>
                      <th className="py-2 px-2">مدل</th>
                      <th className="py-2 px-2 w-20">RPM</th>
                      <th className="py-2 px-2 w-24">Timeout(s)</th>
                      <th className="py-2 px-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {mixedRows.map((row) => (
                      <tr key={row.rowId}>
                        <td className="p-2">
                          <select
                            value={row.providerType}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, {
                                providerType: e.target.value as ProviderType,
                              })
                            }
                            className="w-full px-2 py-1.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                          >
                            <option value="gemini">Gemini</option>
                            <option value="custom_proxy">Proxy واسط</option>
                            <option value="openai">OpenAI</option>
                            <option value="deepseek">DeepSeek</option>
                            <option value="openrouter">OpenRouter</option>
                          </select>
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            value={row.name}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, { name: e.target.value })
                            }
                            className="w-32 px-2 py-1.5 rounded bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            dir="ltr"
                            disabled={row.providerType === 'gemini'}
                            value={row.baseUrl}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, { baseUrl: e.target.value })
                            }
                            placeholder={row.providerType === 'gemini' ? 'مستقیم Gemini' : 'https://.../v1'}
                            className="w-44 px-2 py-1.5 rounded font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 disabled:opacity-45"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="password"
                            dir="ltr"
                            value={row.apiKey}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, { apiKey: e.target.value })
                            }
                            placeholder="AIza... / sk-..."
                            className="w-40 px-2 py-1.5 rounded font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="text"
                            dir="ltr"
                            value={row.modelName}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, { modelName: e.target.value })
                            }
                            className="w-40 px-2 py-1.5 rounded font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            min={1}
                            max={500}
                            value={row.rpmLimit}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, {
                                rpmLimit: Number(e.target.value),
                              })
                            }
                            className="w-16 px-2 py-1.5 rounded font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            min={60}
                            max={900}
                            value={row.timeoutSec}
                            onChange={(e) =>
                              handleMixedRowChange(row.rowId, {
                                timeoutSec: Number(e.target.value),
                              })
                            }
                            className="w-20 px-2 py-1.5 rounded font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                          />
                        </td>
                        <td className="p-2 text-center">
                          {mixedRows.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                setMixedRows((prev) =>
                                  prev.filter((x) => x.rowId !== row.rowId)
                                )
                              }
                              className="p-1 text-slate-400 hover:text-red-500 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setMixedRows((prev) => [
                      ...prev,
                      createMixedRow(
                        (prev[prev.length - 1]?.rowId ?? 0) + 1,
                        'gemini'
                      ),
                    ])
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  افزودن ردیف API دیگر
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('none')}
                    className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                  >
                    انصراف
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                  >
                    ثبت یکجای همه ردیف‌های معتبر
                  </button>
                </div>
              </div>
            </form>
          )}

          {bulkTab === 'same_provider' && (
            <form onSubmit={handleBulkSameProvider} className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
                <select
                  value={bulkType}
                  onChange={(e) => handleBulkTypeChange(e.target.value as ProviderType)}
                  className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                >
                  <option value="gemini">Google Gemini</option>
                  <option value="custom_proxy">API واسط / پروکسی</option>
                  <option value="openai">OpenAI</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
                <input
                  type="text"
                  value={bulkPrefix}
                  onChange={(e) => setBulkPrefix(e.target.value)}
                  placeholder="پیشوند نام"
                  className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                />
                <input
                  type="text"
                  dir="ltr"
                  value={bulkModel}
                  onChange={(e) => setBulkModel(e.target.value)}
                  placeholder="نام مدل"
                  className="px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                />
                {bulkType !== 'gemini' ? (
                  <input
                    type="url"
                    dir="ltr"
                    value={bulkBaseUrl}
                    onChange={(e) => setBulkBaseUrl(e.target.value)}
                    placeholder="Base URL"
                    className="px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                  />
                ) : (
                  <div className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800/60 text-slate-500 flex items-center">
                    اتصال مستقیم Gemini
                  </div>
                )}
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={bulkRpm}
                  onChange={(e) => setBulkRpm(Number(e.target.value))}
                  placeholder="RPM"
                  title="سقف RPM برای هر کلید"
                  className="px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                />
                <input
                  type="number"
                  min={60}
                  max={900}
                  value={bulkTimeoutSec}
                  onChange={(e) => setBulkTimeoutSec(Number(e.target.value))}
                  placeholder="Timeout (s)"
                  title="سقف انتظار پاسخ (ثانیه)"
                  className="px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
                />
              </div>
              <textarea
                rows={5}
                dir="ltr"
                required
                value={bulkKeys}
                onChange={(e) => setBulkKeys(e.target.value)}
                placeholder={'AIzaKey1...\nAIzaKey2...\nAIzaKey3...'}
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="px-4 py-2 font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                >
                  وارد کردن همه کلیدها به صف Failover
                </button>
                <button
                  type="button"
                  onClick={() => setMode('none')}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  انصراف
                </button>
              </div>
            </form>
          )}

          {bulkTab === 'paste_lines' && (
            <form onSubmit={handleSubmitPasteLines} className="space-y-3">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                هر خط با فرمت <code className="font-mono" dir="ltr">type | name | baseUrl | apiKey | model | rpm | timeoutSec</code> یا یک آرایه JSON استاندارد وارد کنید:
              </div>
              <textarea
                rows={6}
                dir="ltr"
                required
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={`gemini | Gemini Main 2 | | AIza... | gemini-3.5-flash-lite | 10 | 300\ncustom_proxy | Proxy Fast | https://my-proxy.example/v1 | sk-... | gemini-3.5-flash-lite | 15 | 420\ndeepseek | DeepSeek Backup | https://api.deepseek.com/v1 | sk-... | deepseek-chat | 20 | 300`}
                className="w-full px-3 py-2 rounded-lg font-mono bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
              />
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="px-4 py-2 font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                >
                  پردازش و ثبت یکجا
                </button>
                <button
                  type="button"
                  onClick={() => setMode('none')}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
                >
                  انصراف
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Providers List */}
      <div className="space-y-3">
        {providers.map((p) => {
          const lastTest = testReplies[p.id];
          const isGemini =
            p.providerType === 'gemini' || p.providerType === 'gemini_builtin';
          const statusLabel =
            p.status === 'healthy'
              ? { text: 'سالم و آماده', cls: 'text-emerald-600 dark:text-emerald-400' }
              : p.status === 'cooldown'
                ? { text: 'استراحت ایمن (Rate Limit)', cls: 'text-amber-600 dark:text-amber-400' }
                : p.status === 'error'
                  ? { text: 'خطا در اتصال', cls: 'text-red-600 dark:text-red-400' }
                  : { text: 'تست نشده', cls: 'text-slate-500 dark:text-slate-400' };

          return (
            <div
              key={p.id}
              className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5"
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                      {p.name}
                    </h3>
                    <span className={`text-xs font-medium ${statusLabel.cls}`}>
                      {statusLabel.text}
                    </span>
                    <span className="text-slate-300 dark:text-slate-700">·</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      اولویت {p.priority}
                    </span>
                    {isGemini && p.rpmLimit > 15 && (
                      <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                        <ShieldAlert className="w-3.5 h-3.5" />
                        RPM بالای ۱۵ ممکن است در جمنای باعث 429 شود
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span>{PROVIDER_META[p.providerType]?.label}</span>
                    <span>·</span>
                    <span className="font-mono">{p.maskedKey}</span>
                    {p.baseUrl && (
                      <>
                        <span>·</span>
                        <span className="font-mono" dir="ltr">{p.baseUrl}</span>
                      </>
                    )}
                    <span>·</span>
                    <span className="font-mono tabular-nums">
                      فاصله ایمن ~{Math.ceil((60 / Math.max(1, p.rpmLimit)) * (isGemini ? 1.18 : 1.08))}s
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums flex flex-wrap items-center gap-3 pt-1">
                    <span>درخواست‌ها: {p.totalRequests.toLocaleString()}</span>
                    <span>·</span>
                    <span>توکن کل: {p.totalTokens.toLocaleString()}</span>
                    {p.lastLatencyMs !== null && (
                      <>
                        <span>·</span>
                        <span>
                          آخرین پاسخ: {(p.lastLatencyMs / 1000).toFixed(1)}s
                          {p.lastLatencyMs > 15000 ? ' (حالت صبور فعال)' : ''}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {/* Inline RPM & Timeout tuning */}
                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>RPM</span>
                    <input
                      type="number"
                      min={1}
                      max={isGemini ? 10 : 500}
                      defaultValue={p.rpmLimit}
                      onBlur={(e) => {
                        const raw = Math.max(1, Number(e.target.value) || p.rpmLimit);
                        const v = isGemini ? Math.min(10, raw) : raw;
                        if (v !== p.rpmLimit) void handleQuickPatch(p.id, { rpmLimit: v });
                      }}
                      title={isGemini ? 'سقف سخت‌گیرانه حداکثر ۱۰ درخواست در دقیقه برای هر کلید Gemini' : 'سقف درخواست در دقیقه'}
                      className="w-14 px-2 py-1 text-xs font-mono rounded bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    />
                  </label>

                  <label className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>Timeout</span>
                    <input
                      type="number"
                      min={60}
                      max={900}
                      defaultValue={Math.round(p.timeoutMs / 1000)}
                      onBlur={(e) => {
                        const v = Math.max(60, Math.min(900, Number(e.target.value) || 300));
                        if (v * 1000 !== p.timeoutMs) {
                          void handleQuickPatch(p.id, { timeoutMs: v * 1000 });
                        }
                      }}
                      className="w-16 px-2 py-1 text-xs font-mono rounded bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100"
                    />
                    <span>s</span>
                  </label>

                  {/* Model Selector or Manual Input */}
                  {p.availableModels.length > 1 ? (
                    <select
                      value={p.modelName}
                      onChange={(e) =>
                        handleQuickPatch(p.id, { modelName: e.target.value })
                      }
                      dir="ltr"
                      className="px-2.5 py-1.5 text-xs font-mono rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 max-w-[210px]"
                    >
                      {Array.from(new Set([p.modelName, ...p.availableModels])).map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      dir="ltr"
                      defaultValue={p.modelName}
                      onBlur={(e) => {
                        if (e.target.value.trim() && e.target.value !== p.modelName) {
                          void handleQuickPatch(p.id, { modelName: e.target.value.trim() });
                        }
                      }}
                      className="px-2.5 py-1.5 text-xs font-mono rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 w-44"
                    />
                  )}

                  <button
                    type="button"
                    disabled={fetchingModelsId === p.id}
                    onClick={() => handleFetchModels(p.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer whitespace-nowrap"
                  >
                    <DownloadCloud className="w-3.5 h-3.5" />
                    {fetchingModelsId === p.id ? 'در حال دریافت...' : 'مدل‌ها'}
                  </button>

                  <button
                    type="button"
                    disabled={testingId === p.id}
                    onClick={() => handleTest(p.id)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 cursor-pointer whitespace-nowrap"
                  >
                    {testingId === p.id ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Activity className="w-3.5 h-3.5" />
                    )}
                    تست API
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      handleQuickPatch(p.id, {
                        enabled: !p.enabled,
                        clearCooldown: !p.enabled,
                      })
                    }
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg border cursor-pointer whitespace-nowrap ${
                      p.enabled
                        ? 'border-emerald-300 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400'
                        : 'border-slate-300 dark:border-slate-700 text-slate-500'
                    }`}
                  >
                    {p.enabled ? 'فعال' : 'غیرفعال'}
                  </button>

                  {p.providerType !== 'gemini_builtin' && (
                    <button
                      type="button"
                      onClick={() => handleDelete(p.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
                      title="حذف"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {(lastTest || p.lastError) && (
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
                  {lastTest?.ok ? (
                    <div className="text-emerald-600 dark:text-emerald-400">
                      پاسخ زنده با {lastTest.modelUsed || p.modelName} ({lastTest.latencyMs}ms · {lastTest.tokensUsed} توکن)
                      {lastTest.fallbackFromModel ? ` [سوئیچ خودکار از ${lastTest.fallbackFromModel}]` : ''}: «{lastTest.reply}»
                    </div>
                  ) : (
                    <div className="text-red-600 dark:text-red-400">
                      آخرین خطا: {lastTest?.error || p.lastError}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
