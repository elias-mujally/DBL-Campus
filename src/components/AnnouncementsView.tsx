import React, { useState } from 'react';
import { Bell, CheckCheck, Pin, Plus, Search } from 'lucide-react';
import type {
  Announcement,
  AnnouncementCategory,
  AnnouncementPriority,
  UserAccount,
} from '../types';
import { hasPermission } from '../utils/domainLogic';
import { apiFetch } from '../utils/api';

interface AnnouncementsViewProps {
  user: UserAccount;
  announcements: Announcement[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  general: 'إعلان عام',
  lectures: 'محاضرات',
  assignments: 'تكاليف',
  exams: 'اختبارات',
  administrative: 'قرارات إدارية',
  urgent: 'تنبيه عاجل',
};

const PRIORITY_LABELS: Record<AnnouncementPriority, string> = {
  normal: 'عادي',
  important: 'مهم',
  urgent: 'عاجل جداً',
};

export const AnnouncementsView: React.FC<AnnouncementsViewProps> = ({
  user,
  announcements,
  onRefresh,
  notify,
}) => {
  const canManage = hasPermission(user, 'announcements');
  const [categoryFilter, setCategoryFilter] = useState<'ALL' | AnnouncementCategory>('ALL');
  const [readFilter, setReadFilter] = useState<'ALL' | 'UNREAD'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState<AnnouncementCategory>('general');
  const [priority, setPriority] = useState<AnnouncementPriority>('normal');
  const [targetGroup, setTargetGroup] = useState('ALL');
  const [isPinned, setIsPinned] = useState(false);

  const handleMarkAsRead = async (id: string) => {
    try {
      await apiFetch(`/api/announcements/${id}/read`, { method: 'POST' });
      await onRefresh();
    } catch {
      // ignore
    }
  };

  const handleTogglePin = async (ann: Announcement) => {
    try {
      await apiFetch(`/api/announcements/${ann.id}/pin`, {
        method: 'PUT',
        body: JSON.stringify({ isPinned: !ann.isPinned }),
      });
      notify(ann.isPinned ? 'تم إلغاء تثبيت الإعلان' : 'تم تثبيت الإعلان في أعلى القائمة');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر التثبيت', 'error');
    }
  };

  const handleCreateAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/announcements', {
        method: 'POST',
        body: JSON.stringify({
          title,
          content,
          category,
          priority,
          targetGroup,
          isPinned,
        }),
      });
      notify('تم نشر الإعلان وإشعار الطلاب المستهدفين');
      setTitle('');
      setContent('');
      setIsPinned(false);
      setShowAddModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر النشر', 'error');
    }
  };

  const filtered = announcements.filter((a) => {
    if (categoryFilter !== 'ALL' && a.category !== categoryFilter) return false;
    if (readFilter === 'UNREAD' && a.isRead) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return a.title.toLowerCase().includes(q) || a.content.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            الإعلانات والتعميمات الأكاديمية
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            متابعة الإعلانات المثبتة والقرارات الإدارية مع تمييز المقروء وغير المقروء.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap self-start md:self-auto"
          >
            <Plus className="w-4 h-4" />
            <span>نشر إعلان جديد</span>
          </button>
        )}
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث في الإعلانات والتعميمات..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 pr-9 pl-3 py-2 text-xs"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as 'ALL' | AnnouncementCategory)}
            aria-label="تصفية حسب الفئة"
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
          >
            <option value="ALL">جميع التصنيفات</option>
            <option value="urgent">تنبيهات عاجلة</option>
            <option value="lectures">محاضرات</option>
            <option value="assignments">تكاليف</option>
            <option value="exams">اختبارات</option>
            <option value="administrative">قرارات إدارية</option>
            <option value="general">إعلانات عامة</option>
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setReadFilter('ALL')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                readFilter === 'ALL'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              الكل
            </button>
            <button
              type="button"
              onClick={() => setReadFilter('UNREAD')}
              className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                readFilter === 'UNREAD'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              غير المقروء فقط
            </button>
          </div>
        </div>
      </div>

      {/* Announcements Feed */}
      <div className="space-y-4">
        {filtered.map((ann) => (
          <div
            key={ann.id}
            id={'result-' + ann.id}
            tabIndex={-1}
            className={`rounded-xl border p-5 transition-colors ${
              ann.priority === 'urgent'
                ? 'border-rose-300 dark:border-rose-800 bg-rose-50/30 dark:bg-rose-950/20'
                : !ann.isRead
                ? 'border-teal-300 dark:border-teal-800 bg-white dark:bg-slate-900'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <div className="flex flex-wrap items-center gap-2">
                {ann.isPinned && (
                  <span className="inline-flex items-center gap-1 font-bold text-amber-700 dark:text-amber-400">
                    <Pin className="w-3.5 h-3.5" />
                    مثبت
                  </span>
                )}
                {ann.isPinned && <span aria-hidden="true">·</span>}
                <span className="font-semibold text-teal-700 dark:text-teal-400">
                  {CATEGORY_LABELS[ann.category]}
                </span>
                <span aria-hidden="true">·</span>
                <span>الأهمية: {PRIORITY_LABELS[ann.priority]}</span>
                <span aria-hidden="true">·</span>
                <span>
                  المستهدفون:{' '}
                  {ann.targetGroup === 'ALL' ? 'الدفعة كاملة' : `مجموعة ${ann.targetGroup}`}
                </span>
              </div>

              <div className="flex items-center gap-2 font-mono tabular-nums">
                <span>{ann.createdAt.slice(0, 10)}</span>
                <span aria-hidden="true">·</span>
                <span>{ann.isRead ? 'مقروء' : 'غير مقروء'}</span>
              </div>
            </div>

            <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-2">
              {ann.title}
            </h3>
            <p className="text-sm text-slate-700 dark:text-slate-300 mt-2 leading-relaxed whitespace-pre-line">
              {ann.content}
            </p>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-slate-500">الناشر: {ann.publisherName}</span>

              <div className="flex items-center gap-2">
                {!ann.isRead && (
                  <button
                    type="button"
                    onClick={() => handleMarkAsRead(ann.id)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300 font-semibold hover:bg-teal-100"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                    <span>تعليم كمقروء</span>
                  </button>
                )}

                {canManage && (
                  <button
                    type="button"
                    onClick={() => handleTogglePin(ann)}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <Pin className="w-3.5 h-3.5" />
                    <span>{ann.isPinned ? 'إلغاء التثبيت' : 'تثبيت الإعلان'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add Announcement Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-ann-title"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="add-ann-title" className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
              <Bell className="w-5 h-5 text-teal-600" />
              <span>نشر إعلان جديد للدفعة</span>
            </h3>
            <form onSubmit={handleCreateAnnouncement} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">عنوان الإعلان</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="عنوان واضح ومباشر..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold mb-1">التصنيف</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as AnnouncementCategory)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="general">إعلان عام</option>
                    <option value="lectures">محاضرات</option>
                    <option value="assignments">تكاليف</option>
                    <option value="exams">اختبارات</option>
                    <option value="administrative">قرارات إدارية</option>
                    <option value="urgent">تنبيه عاجل</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold mb-1">مستوى الأهمية</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as AnnouncementPriority)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="normal">عادي</option>
                    <option value="important">مهم</option>
                    <option value="urgent">عاجل جداً</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold mb-1">الفئة المستهدفة</label>
                  <select
                    value={targetGroup}
                    onChange={(e) => setTargetGroup(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="ALL">الدفعة كاملة (ALL)</option>
                    <option value="A">المجموعة A</option>
                    <option value="B">المجموعة B</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">نص الإعلان بالتفصيل</label>
                <textarea
                  rows={4}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  required
                  placeholder="اكتب تفاصيل الإعلان..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <label className="flex items-center gap-2 font-semibold text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={isPinned}
                  onChange={(e) => setIsPinned(e.target.checked)}
                />
                <span>تثبيت هذا الإعلان في أعلى لوحة التحكم</span>
              </label>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  نشر الإعلان
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
