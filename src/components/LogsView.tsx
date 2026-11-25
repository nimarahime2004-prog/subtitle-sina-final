import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpLeft,
  CheckCircle2,
  Clock,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { ApiProvider, OperationLog } from '../shared/types.ts';
import { api } from '../lib/api.ts';

interface LogsViewProps {
  logs: OperationLog[];
  providers: ApiProvider[];
  onRefresh: (level?: string) => Promise<void>;
  onRefreshProviders: () => Promise<void>;
  onOpenProviders: () => void;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

type ErrorCodeCategory = '403' | '401' | '429' | '503' | '404' | 'other';

interface ErrorDiagnosticInfo {
  category: ErrorCodeCategory;
  codeLabel: string;
  title: string;
  reason: string;
  recommendation: string;
  mustReplace: boolean;
  severity: 'critical' | 'warning' | 'info';
}

interface ProviderDiagnosis {
  provider: ApiProvider;
  info: ErrorDiagnosticInfo;
  occurrencesInLogs: number;
  rawSnippet: string;
}

const LEVEL_STYLES: Record<OperationLog['level'], { label: string; cls: string }> = {
  success: { label: 'موفق', cls: 'text-emerald-600 dark:text-emerald-400 font-medium' },
  info: { label: 'اطلاعات', cls: 'text-blue-600 dark:text-blue-400' },
  warn: { label: 'هشدار', cls: 'text-amber-600 dark:text-amber-400 font-medium' },
  error: { label: 'خطا', cls: 'text-red-600 dark:text-red-400 font-semibold' },
};

const CATEGORY_META: Record<
  ErrorCodeCategory,
  { code: string; label: string; shortDesc: string; toneClass: string }
> = {
  '403': {
    code: '403',
    label: 'تعلیق پروژه / عدم دسترسی',
    shortDesc: 'پروژه مسدود یا کلید فاقد مجوز است — باید جایگزین شود',
    toneClass: 'text-red-600 dark:text-red-400',
  },
  '401': {
    code: '401',
    label: 'کلید API نامعتبر',
    shortDesc: 'کلید اشتباه یا منقضی شده است — باید جایگزین شود',
    toneClass: 'text-red-600 dark:text-red-400',
  },
  '429': {
    code: '429',
    label: 'محدودیت نرخ / سهمیه (RPM/Quota)',
    shortDesc: 'سقف درخواست دقیقه‌ای یا سهمیه روزانه پر شده است',
    toneClass: 'text-amber-600 dark:text-amber-400',
  },
  '503': {
    code: '503 / 500',
    label: 'شلوغی سرور یا تأخیر (Timeout)',
    shortDesc: 'موقت است — سیستم خودکار صبر می‌کند یا روی 3.1 سوییچ می‌کند',
    toneClass: 'text-blue-600 dark:text-blue-400',
  },
  '404': {
    code: '404',
    label: 'مدل یا آدرس نامعتبر',
    shortDesc: 'نام مدل یا Base URL در تنظیمات سرویس نیاز به اصلاح دارد',
    toneClass: 'text-purple-600 dark:text-purple-400',
  },
  other: {
    code: 'سایر',
    label: 'خطای شبکه یا پاسخ ناقص',
    shortDesc: 'اختلال اتصال یا خطای غیرمنتظره — تست مجدد پیشنهاد می‌شود',
    toneClass: 'text-slate-600 dark:text-slate-400',
  },
};

function classifyErrorText(
  text: string,
  provider?: ApiProvider
): ErrorDiagnosticInfo | null {
  const raw = (text || '').trim();
  const lower = raw.toLowerCase();

  if (
    lower.includes('403') ||
    lower.includes('consumer_suspended') ||
    lower.includes('has been suspended') ||
    lower.includes('permission_denied') ||
    lower.includes('permission denied')
  ) {
    const isSuspended =
      lower.includes('consumer_suspended') || lower.includes('suspended');
    return {
      category: '403',
      codeLabel: 'HTTP 403',
      title: isSuspended ? 'تعلیق پروژه Google Cloud' : 'عدم دسترسی (Permission Denied)',
      reason: isSuspended
        ? 'پروژه متصل به این کلید توسط گوگل تعلیق شده است (CONSUMER_SUSPENDED) و دیگر کار نمی‌کند.'
        : 'این کلید مجوز دسترسی به سرویس یا مدل انتخاب‌شده را ندارد.',
      recommendation: 'این کلید را در پنل «مدیریت APIها» حذف یا با کلید جدید جایگزین کنید.',
      mustReplace: true,
      severity: 'critical',
    };
  }

  if (
    lower.includes('401') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key') ||
    lower.includes('احراز هویت')
  ) {
    return {
      category: '401',
      codeLabel: 'HTTP 401',
      title: 'کلید API نامعتبر یا منقضی',
      reason: 'کلید واردشده توسط سرور مقصد رد شده یا باطل شده است.',
      recommendation: 'کلید صحیح را در پنل «مدیریت APIها» جایگزین کنید.',
      mustReplace: true,
      severity: 'critical',
    };
  }

  if (
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('محدودیت نرخ') ||
    lower.includes('rpm/سهمیه') ||
    lower.includes('quota')
  ) {
    const isZeroQuota =
      lower.includes('limit: 0') ||
      lower.includes('free_tier') ||
      (provider !== undefined && provider.totalRequests === 0);
    return {
      category: '429',
      codeLabel: 'HTTP 429',
      title: isZeroQuota
        ? 'اتمام سهمیه یا محدودیت پلن رایگان'
        : 'محدودیت نرخ درخواست (RPM)',
      reason: isZeroQuota
        ? 'این کلید بدون ثبت درخواست موفق با خطای سهمیه (429) مواجه شده است؛ احتمالاً سهمیه روزانه تمام شده یا مدل روی پلن رایگان محدود است.'
        : 'تعداد درخواست در دقیقه به سقف مجاز رسیده و کلید وارد استراحت ایمن شده است.',
      recommendation: isZeroQuota
        ? 'مدل را به gemini-3.1-flash-lite تغییر دهید یا در صورت تکرار، کلید را در پنل «مدیریت APIها» جایگزین کنید.'
        : 'نیاز به جایگزینی نیست؛ پس از پایان زمان استراحت به‌صورت خودکار فعال می‌شود.',
      mustReplace: isZeroQuota,
      severity: 'warning',
    };
  }

  if (
    lower.includes('503') ||
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded') ||
    lower.includes('timeout') ||
    lower.includes('مهلت زمانی') ||
    lower.includes('تأخیر یا خطای موقت')
  ) {
    return {
      category: '503',
      codeLabel: lower.includes('timeout') || lower.includes('مهلت') ? 'Timeout' : 'HTTP 503',
      title: 'شلوغی موقت سرور یا تأخیر پاسخ',
      reason: 'سرور مدل موقتاً شلوغ است یا پاسخ با تأخیر ارسال شده است.',
      recommendation:
        'موقت است؛ سیستم منتظر پاسخ می‌ماند و در صورت تداوم به مدل 3.1 فلش لایت یا API سالم بعدی سوییچ می‌کند.',
      mustReplace: false,
      severity: 'info',
    };
  }

  if (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('models/') ||
    lower.includes('مدل یافت نشد')
  ) {
    return {
      category: '404',
      codeLabel: 'HTTP 404',
      title: 'مدل یا آدرس سرویس یافت نشد',
      reason: 'نام مدل یا Base URL تنظیم‌شده برای این کلید در سرور مقصد وجود ندارد.',
      recommendation:
        'در پنل «مدیریت APIها»، نام مدل (مثلاً gemini-3.1-flash-lite) یا آدرس سرویس را اصلاح کنید.',
      mustReplace: false,
      severity: 'warning',
    };
  }

  if (raw.length > 0) {
    return {
      category: 'other',
      codeLabel: 'خطا',
      title: 'خطای اتصال یا پاسخ سرویس',
      reason: raw.slice(0, 180),
      recommendation: 'اتصال کلید را تست کنید؛ در صورت تکرار خطا آن را جایگزین نمایید.',
      mustReplace: provider?.status === 'error',
      severity: 'warning',
    };
  }

  return null;
}

export function LogsView({
  logs,
  providers,
  onRefresh,
  onRefreshProviders,
  onOpenProviders,
  onNotify,
}: LogsViewProps) {
  const [levelFilter, setLevelFilter] = useState('all');
  const [codeFilter, setCodeFilter] = useState<'all' | ErrorCodeCategory>('all');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmDeleteBroken, setConfirmDeleteBroken] = useState(false);

  const handleFilter = async (lvl: string) => {
    setLevelFilter(lvl);
    await onRefresh(lvl);
  };

  const handleClear = async () => {
    await api.clearLogs();
    await onRefresh(levelFilter);
    onNotify('تاریخچه گزارش‌ها پاکسازی شد.', 'info');
  };

  // Analyze logs & providers for error code breakdown and replacement suggestions
  const diagnostics = useMemo(() => {
    const logCountsByCode: Record<ErrorCodeCategory, number> = {
      '403': 0,
      '401': 0,
      '429': 0,
      '503': 0,
      '404': 0,
      other: 0,
    };

    const latestLogErrorByProvider = new Map<
      string,
      { message: string; count: number; info: ErrorDiagnosticInfo }
    >();

    for (const log of logs) {
      if (log.level !== 'error' && log.level !== 'warn') continue;
      const classified = classifyErrorText(log.message);
      if (!classified) continue;
      logCountsByCode[classified.category] += 1;

      if (log.providerName) {
        const prev = latestLogErrorByProvider.get(log.providerName);
        if (!prev) {
          latestLogErrorByProvider.set(log.providerName, {
            message: log.message,
            count: 1,
            info: classified,
          });
        } else {
          prev.count += 1;
        }
      }
    }

    const providerDiagnoses: ProviderDiagnosis[] = [];
    let healthyOrReadyCount = 0;
    let mustReplaceCount = 0;
    let rateLimitedCount = 0;
    let tempErrorCount = 0;

    for (const p of providers) {
      const logMeta = latestLogErrorByProvider.get(p.name);
      const hasDirectError = Boolean(p.lastError) || p.status === 'error';
      const isCooldown = p.status === 'cooldown';

      if (!hasDirectError && !isCooldown && p.enabled) {
        healthyOrReadyCount += 1;
        // Still surface if there are repeated log errors for this provider
        if (!logMeta || logMeta.info.category === '503') {
          if (logMeta && logMeta.info.category === '503') {
            tempErrorCount += 1;
          }
          continue;
        }
      }

      const rawText =
        p.lastError ||
        logMeta?.message ||
        (isCooldown ? '429 محدودیت نرخ (استراحت)' : p.status === 'error' ? 'خطا در کلید API' : '');

      const info = classifyErrorText(rawText, p);
      if (!info) continue;

      if (info.category === '403' || info.category === '401') {
        mustReplaceCount += 1;
      } else if (info.category === '429') {
        rateLimitedCount += 1;
        if (info.mustReplace) mustReplaceCount += 1;
      } else if (info.category === '503') {
        tempErrorCount += 1;
      } else if (info.mustReplace) {
        mustReplaceCount += 1;
      }

      providerDiagnoses.push({
        provider: p,
        info,
        occurrencesInLogs: logMeta?.count || 0,
        rawSnippet: rawText.slice(0, 180),
      });
    }

    // Sort: critical (403/401) first, then 429 mustReplace, then 404/other, then temporary 429/503
    const priorityRank = (d: ProviderDiagnosis): number => {
      if (d.info.category === '403') return 1;
      if (d.info.category === '401') return 2;
      if (d.info.mustReplace) return 3;
      if (d.info.category === '404') return 4;
      if (d.info.category === '429') return 5;
      if (d.info.category === '503') return 6;
      return 7;
    };

    providerDiagnoses.sort((a, b) => priorityRank(a) - priorityRank(b));

    const brokenCriticalIds = providerDiagnoses
      .filter(
        (d) =>
          d.provider.providerType !== 'gemini_builtin' &&
          (d.info.category === '403' ||
            d.info.category === '401' ||
            d.provider.status === 'error')
      )
      .map((d) => d.provider.id);

    const activeCooldownCount = providers.filter((p) => p.status === 'cooldown').length;

    return {
      logCountsByCode,
      providerDiagnoses,
      healthyOrReadyCount,
      mustReplaceCount,
      rateLimitedCount,
      tempErrorCount,
      brokenCriticalIds,
      activeCooldownCount,
    };
  }, [logs, providers]);

  const filteredLogs = useMemo(() => {
    if (codeFilter === 'all') return logs;
    return logs.filter((log) => {
      if (log.level !== 'error' && log.level !== 'warn') return false;
      const classified = classifyErrorText(log.message);
      return classified?.category === codeFilter;
    });
  }, [logs, codeFilter]);

  const handleBulkCleanup = async (
    action: 'disable_errors' | 'delete_errors' | 'clear_cooldowns'
  ) => {
    setBusyAction(action);
    try {
      const res = await api.cleanupProviderErrors({
        action,
        providerIds:
          action === 'clear_cooldowns' ? undefined : diagnostics.brokenCriticalIds,
      });
      await Promise.all([onRefresh(levelFilter), onRefreshProviders()]);
      setConfirmDeleteBroken(false);
      if (action === 'disable_errors') {
        onNotify(
          `${res.affected} کلید خراب غیرفعال (قرنطینه) شد تا دیگر سرعت صف را نگیرد.`,
          'success'
        );
      } else if (action === 'delete_errors') {
        onNotify(`${res.affected} کلید مسدود/خراب از لیست حذف شد.`, 'info');
      } else {
        onNotify(
          `استراحت (Cooldown) تعداد ${res.affected} کلید پاکسازی و دوباره آماده شد.`,
          'success'
        );
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در اجرای عملیات پاکسازی', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleSingleTest = async (providerId: number) => {
    setBusyAction(`test-${providerId}`);
    try {
      const res = await api.testProvider(providerId);
      await Promise.all([onRefresh(levelFilter), onRefreshProviders()]);
      if (res.result.ok) {
        onNotify(
          `اتصال «${res.provider.name}» با مدل ${res.result.modelUsed} موفق بود (${res.result.latencyMs}ms).`,
          'success'
        );
      } else {
        onNotify(
          `تست «${res.provider.name}» ناموفق بود: ${res.result.error || 'خطای اتصال'}`,
          'error'
        );
      }
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در تست کلید', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDisableSingle = async (provider: ApiProvider) => {
    setBusyAction(`disable-${provider.id}`);
    try {
      await api.updateProvider(provider.id, { enabled: false });
      await onRefreshProviders();
      onNotify(`کلید «${provider.name}» غیرفعال شد.`, 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در غیرفعال‌سازی', 'error');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Smart API Diagnostic & Key Replacement Advisor */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Stethoscope className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                عیب‌یاب هوشمند خطاهای API و راهنمای جایگزینی کلیدها
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                تفکیک خودکار کدهای 403، 401، 429 و 503 برای شناسایی کلیدهای مسدود و جلوگیری از توقف صف ترجمه
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onOpenProviders}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors cursor-pointer"
            >
              <Wrench className="w-3.5 h-3.5" />
              جایگزینی در پنل مدیریت APIها
              <ArrowUpLeft className="w-3.5 h-3.5" />
            </button>

            {diagnostics.activeCooldownCount > 0 && (
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => handleBulkCleanup('clear_cooldowns')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-300 dark:border-amber-800 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40 transition-colors cursor-pointer disabled:opacity-50"
              >
                <Clock className="w-3.5 h-3.5" />
                رفع استراحت ({diagnostics.activeCooldownCount})
              </button>
            )}

            {diagnostics.brokenCriticalIds.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => handleBulkCleanup('disable_errors')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                >
                  <ShieldAlert className="w-3.5 h-3.5" />
                  غیرفعال‌سازی خراب‌ها ({diagnostics.brokenCriticalIds.length})
                </button>

                {!confirmDeleteBroken ? (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => setConfirmDeleteBroken(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-red-200 dark:border-red-900/60 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    حذف کلیدهای مسدود
                  </button>
                ) : (
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-red-300 dark:border-red-800 bg-red-50/70 dark:bg-red-950/40 text-xs">
                    <span className="text-red-700 dark:text-red-300">حذف شود؟</span>
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => handleBulkCleanup('delete_errors')}
                      className="px-2 py-0.5 rounded bg-red-600 text-white font-medium cursor-pointer"
                    >
                      بله
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteBroken(false)}
                      className="px-2 py-0.5 rounded text-slate-600 dark:text-slate-300 cursor-pointer"
                    >
                      انصراف
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Summary KPI Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-4 divide-y lg:divide-y-0 lg:divide-x lg:divide-x-reverse divide-slate-200 dark:divide-slate-800 border-b border-slate-200 dark:border-slate-800">
          <div className="p-4">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              کلیدهای آماده و سالم
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                {diagnostics.healthyOrReadyCount}
              </span>
              <span className="text-[11px] text-slate-400">
                از {providers.length} سرویس
              </span>
            </div>
          </div>

          <div className="p-4">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              نیازمند جایگزینی (403 / 401 / سهمیه صفر)
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold font-mono tabular-nums text-red-600 dark:text-red-400">
                {diagnostics.mustReplaceCount}
              </span>
              <span className="text-[11px] text-slate-400">کلید معیوب</span>
            </div>
          </div>

          <div className="p-4">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              محدودیت نرخ / استراحت (429)
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold font-mono tabular-nums text-amber-600 dark:text-amber-400">
                {diagnostics.rateLimitedCount}
              </span>
              <span className="text-[11px] text-slate-400">
                ({diagnostics.logCountsByCode['429']} رویداد)
              </span>
            </div>
          </div>

          <div className="p-4">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              شلوغی سرور / تأخیر موقت (503 / Timeout)
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-xl font-semibold font-mono tabular-nums text-blue-600 dark:text-blue-400">
                {diagnostics.logCountsByCode['503']}
              </span>
              <span className="text-[11px] text-slate-400">رویداد ثبت‌شده</span>
            </div>
          </div>
        </div>

        {/* Error Code Breakdown Strip (Interactive Filter for Logs) */}
        <div className="px-5 py-3.5 bg-slate-50/70 dark:bg-slate-900/40 border-b border-slate-200 dark:border-slate-800">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-2.5">
            تفکیک کدهای خطای دریافتی از API (برای فیلتر کردن تاریخچه رویدادها روی هر کد کلیک کنید):
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            {(['403', '401', '429', '503', '404'] as ErrorCodeCategory[]).map((cat) => {
              const meta = CATEGORY_META[cat];
              const logCount = diagnostics.logCountsByCode[cat];
              const providerCount = diagnostics.providerDiagnoses.filter(
                (d) => d.info.category === cat
              ).length;
              const isSelected = codeFilter === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCodeFilter(isSelected ? 'all' : cat)}
                  className={`text-right p-3 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-blue-500 bg-blue-50/60 dark:bg-blue-950/30'
                      : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-[#111827] hover:border-slate-300 dark:hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-xs font-mono font-semibold ${meta.toneClass}`} dir="ltr">
                      {meta.code}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {providerCount} کلید · {logCount} خطا
                    </span>
                  </div>
                  <div className="text-xs font-medium text-slate-800 dark:text-slate-100 mt-1">
                    {meta.label}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                    {meta.shortDesc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Key-by-Key Replacement Recommendations */}
        <div className="p-5">
          {diagnostics.providerDiagnoses.length === 0 ? (
            <div className="flex items-center gap-2.5 text-xs text-emerald-700 dark:text-emerald-400 py-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                هیچ کلید مسدود یا خطاداری در سرویس‌های فعلی شناسایی نشد. همه کلیدهای فعال آماده ترجمه هستند.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                  کلیدهای نیازمند بررسی یا جایگزینی ({diagnostics.providerDiagnoses.length} مورد)
                </h3>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  کلیدهای 403/401 به‌صورت خودکار قرنطینه می‌شوند تا صف ترجمه متوقف نشود
                </span>
              </div>

              <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                <table className="w-full text-right border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      <th className="py-2.5 px-3">نام سرویس / کلید</th>
                      <th className="py-2.5 px-3">کد خطا</th>
                      <th className="py-2.5 px-3">تشخیص دقیق</th>
                      <th className="py-2.5 px-3">پیشنهاد برای کاربر</th>
                      <th className="py-2.5 px-3 text-left">اقدام</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                    {diagnostics.providerDiagnoses.map((item) => {
                      const { provider: p, info } = item;
                      const isCritical = info.severity === 'critical';
                      return (
                        <tr key={p.id} className="align-top">
                          <td className="py-3 px-3">
                            <div className="font-medium text-slate-900 dark:text-slate-100">
                              {p.name}
                            </div>
                            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5" dir="ltr">
                              {p.maskedKey || p.modelName}
                              {!p.enabled ? ' · غیرفعال' : ''}
                            </div>
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap">
                            <span
                              className={`font-mono font-semibold ${
                                isCritical
                                  ? 'text-red-600 dark:text-red-400'
                                  : info.severity === 'warning'
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-blue-600 dark:text-blue-400'
                              }`}
                              dir="ltr"
                            >
                              {info.codeLabel}
                            </span>
                            {item.occurrencesInLogs > 0 && (
                              <div className="text-[11px] font-mono tabular-nums text-slate-400 mt-0.5">
                                {item.occurrencesInLogs} بار
                              </div>
                            )}
                          </td>
                          <td className="py-3 px-3 max-w-xs">
                            <div className="font-medium text-slate-800 dark:text-slate-200">
                              {info.title}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-relaxed">
                              {info.reason}
                            </div>
                          </td>
                          <td className="py-3 px-3 max-w-xs">
                            <div
                              className={`text-[11px] leading-relaxed ${
                                info.mustReplace
                                  ? 'text-red-700 dark:text-red-300 font-medium'
                                  : 'text-slate-600 dark:text-slate-300'
                              }`}
                            >
                              {info.recommendation}
                            </div>
                          </td>
                          <td className="py-3 px-3 whitespace-nowrap text-left">
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busyAction !== null}
                                onClick={() => handleSingleTest(p.id)}
                                className="text-blue-600 dark:text-blue-400 hover:underline cursor-pointer disabled:opacity-50"
                              >
                                {busyAction === `test-${p.id}` ? 'تست...' : 'تست'}
                              </button>
                              {p.enabled && p.providerType !== 'gemini_builtin' && (
                                <>
                                  <span className="text-slate-300 dark:text-slate-700">·</span>
                                  <button
                                    type="button"
                                    disabled={busyAction !== null}
                                    onClick={() => handleDisableSingle(p)}
                                    className="text-amber-600 dark:text-amber-400 hover:underline cursor-pointer disabled:opacity-50"
                                  >
                                    غیرفعال
                                  </button>
                                </>
                              )}
                              {info.mustReplace && (
                                <>
                                  <span className="text-slate-300 dark:text-slate-700">·</span>
                                  <button
                                    type="button"
                                    onClick={onOpenProviders}
                                    className="text-red-600 dark:text-red-400 font-medium hover:underline cursor-pointer"
                                  >
                                    جایگزینی
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Provider Consumption Breakdown */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
            گزارش مصرف توکن، سرعت پاسخ و وضعیت APIها
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-right border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">نام سرویس</th>
                <th className="py-3 px-4">مدل فعال</th>
                <th className="py-3 px-4 text-left">تعداد درخواست</th>
                <th className="py-3 px-4 text-left">کل توکن</th>
                <th className="py-3 px-4 text-left">آخرین تأخیر</th>
                <th className="py-3 px-4">وضعیت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {providers.map((p) => {
                const diag = p.lastError ? classifyErrorText(p.lastError, p) : null;
                return (
                  <tr key={p.id} className={!p.enabled ? 'opacity-60' : ''}>
                    <td className="py-3 px-4 font-medium text-slate-900 dark:text-slate-100">
                      {p.name}
                    </td>
                    <td className="py-3 px-4 font-mono text-slate-500 dark:text-slate-400" dir="ltr">
                      {p.modelName}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-left">
                      {p.totalRequests.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-left">
                      {p.totalTokens.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-left">
                      {p.lastLatencyMs !== null ? `${p.lastLatencyMs} ms` : '—'}
                    </td>
                    <td className="py-3 px-4">
                      {!p.enabled ? (
                        <span className="text-red-600 dark:text-red-400 font-medium">
                          غیرفعال (قرنطینه{diag ? ` · ${diag.codeLabel}` : ''})
                        </span>
                      ) : p.status === 'healthy' ? (
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                          سالم
                        </span>
                      ) : p.status === 'cooldown' ? (
                        <span className="text-amber-600 dark:text-amber-400 font-medium">
                          محدودیت نرخ (استراحت)
                        </span>
                      ) : p.status === 'error' ? (
                        <span className="text-red-600 dark:text-red-400 font-semibold">
                          خطا{diag ? ` (${diag.codeLabel})` : ''}
                        </span>
                      ) : (
                        <span className="text-slate-500">تست نشده</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Operation History & Error Logs */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg">
              {[
                ['all', 'همه رویدادها'],
                ['success', 'موفق'],
                ['info', 'اطلاعات'],
                ['warn', 'هشدار و Failover'],
                ['error', 'خطاها'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setCodeFilter('all');
                    handleFilter(k);
                  }}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                    levelFilter === k && codeFilter === 'all'
                      ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {codeFilter !== 'all' && (
              <button
                type="button"
                onClick={() => setCodeFilter('all')}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline cursor-pointer"
              >
                فیلتر فعال: کد {CATEGORY_META[codeFilter].code} (حذف فیلتر)
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => Promise.all([onRefresh(levelFilter), onRefreshProviders()])}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              بروزرسانی
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/60 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              پاکسازی تاریخچه
            </button>
          </div>
        </div>

        <div className="divide-y divide-slate-100 dark:divide-slate-800/80 text-xs max-h-[520px] overflow-y-auto">
          {filteredLogs.length === 0 ? (
            <div className="p-10 text-center text-slate-500">
              {codeFilter !== 'all'
                ? `رویدادی با کد خطای ${CATEGORY_META[codeFilter].code} در تاریخچه فعلی یافت نشد.`
                : 'رویدادی در تاریخچه ثبت نشده است.'}
            </div>
          ) : (
            filteredLogs.map((log) => {
              const st = LEVEL_STYLES[log.level];
              const diag =
                log.level === 'error' || log.level === 'warn'
                  ? classifyErrorText(log.message)
                  : null;
              return (
                <div
                  key={log.id}
                  className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={st.cls}>{st.label}</span>
                      {diag && (
                        <>
                          <span className="text-slate-300 dark:text-slate-700">·</span>
                          <span
                            className={`font-mono text-[11px] font-semibold ${CATEGORY_META[diag.category].toneClass}`}
                            dir="ltr"
                          >
                            {diag.codeLabel}
                          </span>
                        </>
                      )}
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="text-slate-800 dark:text-slate-200 break-words">
                        {log.message}
                      </span>
                    </div>
                    {(log.providerName || log.tokensUsed > 0 || log.latencyMs) && (
                      <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 flex items-center gap-2">
                        {log.providerName && <span>{log.providerName}</span>}
                        {log.modelName && <span dir="ltr">({log.modelName})</span>}
                        {log.tokensUsed > 0 && <span>· {log.tokensUsed.toLocaleString()} tok</span>}
                        {log.latencyMs !== null && <span>· {log.latencyMs}ms</span>}
                      </div>
                    )}
                  </div>
                  <div className="font-mono tabular-nums text-[11px] text-slate-400 shrink-0" dir="ltr">
                    {log.createdAt}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
