import React, { useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import type { ApiProvider, OperationLog } from '../shared/types.ts';
import { api } from '../lib/api.ts';

interface LogsViewProps {
  logs: OperationLog[];
  providers: ApiProvider[];
  onRefresh: (level?: string) => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const LEVEL_STYLES: Record<OperationLog['level'], { label: string; cls: string }> = {
  success: { label: 'موفق', cls: 'text-emerald-600 dark:text-emerald-400 font-medium' },
  info: { label: 'اطلاعات', cls: 'text-blue-600 dark:text-blue-400' },
  warn: { label: 'هشدار', cls: 'text-amber-600 dark:text-amber-400 font-medium' },
  error: { label: 'خطا', cls: 'text-red-600 dark:text-red-400 font-semibold' },
};

export function LogsView({
  logs,
  providers,
  onRefresh,
  onNotify,
}: LogsViewProps) {
  const [levelFilter, setLevelFilter] = useState('all');

  const handleFilter = async (lvl: string) => {
    setLevelFilter(lvl);
    await onRefresh(lvl);
  };

  const handleClear = async () => {
    await api.clearLogs();
    await onRefresh(levelFilter);
    onNotify('تاریخچه گزارش‌ها پاکسازی شد.', 'info');
  };

  return (
    <div className="space-y-6">
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
              {providers.map((p) => (
                <tr key={p.id}>
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
                    {p.status === 'healthy'
                      ? 'سالم'
                      : p.status === 'cooldown'
                        ? 'محدودیت نرخ (استراحت)'
                        : p.status === 'error'
                          ? 'خطا'
                          : 'تست نشده'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Operation History & Error Logs */}
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
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
                onClick={() => handleFilter(k)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                  levelFilter === k
                    ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRefresh(levelFilter)}
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
          {logs.length === 0 ? (
            <div className="p-10 text-center text-slate-500">
              رویدادی در تاریخچه ثبت نشده است.
            </div>
          ) : (
            logs.map((log) => {
              const st = LEVEL_STYLES[log.level];
              return (
                <div
                  key={log.id}
                  className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={st.cls}>{st.label}</span>
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="text-slate-800 dark:text-slate-200">{log.message}</span>
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
