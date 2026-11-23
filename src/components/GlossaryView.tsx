import React, { useState } from 'react';
import { BookMarked, Plus, Trash2 } from 'lucide-react';
import type { GlossaryTerm } from '../shared/types.ts';
import { api } from '../lib/api.ts';

interface GlossaryViewProps {
  projectId: number | null;
  terms: GlossaryTerm[];
  onRefresh: () => Promise<void>;
  onNotify: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export function GlossaryView({
  projectId,
  terms,
  onRefresh,
  onNotify,
}: GlossaryViewProps) {
  const [sourceTerm, setSourceTerm] = useState('');
  const [targetTerm, setTargetTerm] = useState('');
  const [notes, setNotes] = useState('');
  const [scope, setScope] = useState<'project' | 'global'>('project');
  const [caseSensitive, setCaseSensitive] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceTerm.trim() || !targetTerm.trim()) return;
    try {
      await api.addGlossaryTerm({
        projectId: scope === 'project' ? projectId : null,
        sourceTerm: sourceTerm.trim(),
        targetTerm: targetTerm.trim(),
        caseSensitive,
        wholeWord: true,
        notes: notes.trim(),
      });
      setSourceTerm('');
      setTargetTerm('');
      setNotes('');
      await onRefresh();
      onNotify('اصطلاح جدید به واژه‌نامه اضافه شد و در ترجمه‌های بعدی اعمال می‌شود.', 'success');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در افزودن اصطلاح', 'error');
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.deleteGlossaryTerm(id);
      await onRefresh();
      onNotify('اصطلاح از واژه‌نامه حذف شد.', 'info');
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'خطا در حذف', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl p-5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
          واژه‌نامه اختصاصی اصطلاحات و نام‌های خاص
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          هر اصطلاحی که در این بخش ثبت شود، هنگام ترجمه هر بسته زیرنویس به صورت هوشمند به هوش مصنوعی تزریق می‌شود تا معادل فارسی یکدست و دقیق حفظ شود.
        </p>

        <form onSubmit={handleAdd} className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3 text-xs">
          <input
            type="text"
            dir="ltr"
            required
            value={sourceTerm}
            onChange={(e) => setSourceTerm(e.target.value)}
            placeholder="English term (e.g. Consciousness)"
            className="md:col-span-3 px-3 py-2 rounded-lg font-en bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
          />
          <input
            type="text"
            required
            value={targetTerm}
            onChange={(e) => setTargetTerm(e.target.value)}
            placeholder="معادل دقیق فارسی (مثلاً: خودآگاهی)"
            className="md:col-span-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
          />
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="توضیح زمینه (اختیاری)"
            className="md:col-span-3 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
          />
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value as 'project' | 'global')}
            className="md:col-span-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700"
          >
            <option value="project">پروژه فعلی</option>
            <option value="global">سراسری (همه پروژه‌ها)</option>
          </select>
          <button
            type="submit"
            className="md:col-span-1 inline-flex items-center justify-center gap-1 px-3 py-2 font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            ثبت
          </button>
          <div className="md:col-span-12">
            <label className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              حساس به حروف بزرگ و کوچک انگلیسی
            </label>
          </div>
        </form>
      </div>

      <div className="bg-white dark:bg-[#111827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {terms.length === 0 ? (
          <div className="p-12 text-center">
            <BookMarked className="w-6 h-6 mx-auto text-slate-400" />
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              هنوز اصطلاحی در واژه‌نامه ثبت نشده است.
            </p>
          </div>
        ) : (
          <table className="w-full text-right border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">اصطلاح انگلیسی</th>
                <th className="py-3 px-4">معادل فارسی</th>
                <th className="py-3 px-4">محدوده</th>
                <th className="py-3 px-4">یادداشت</th>
                <th className="py-3 px-4 text-left">حذف</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
              {terms.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/35">
                  <td className="py-3 px-4 font-en font-medium text-slate-900 dark:text-slate-100" dir="ltr">
                    {t.sourceTerm}
                  </td>
                  <td className="py-3 px-4 font-medium text-blue-600 dark:text-blue-400">
                    {t.targetTerm}
                  </td>
                  <td className="py-3 px-4 text-slate-500 dark:text-slate-400">
                    {t.projectId === null ? 'سراسری' : 'پروژه فعلی'}
                  </td>
                  <td className="py-3 px-4 text-slate-500 dark:text-slate-400">
                    {t.notes || '—'}
                  </td>
                  <td className="py-3 px-4 text-left">
                    <button
                      type="button"
                      onClick={() => handleDelete(t.id)}
                      className="p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
