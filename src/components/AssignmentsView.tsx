import React, { useState } from 'react';
import {
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type {
  Assignment,
  Course,
  PersonalProgressStatus,
  SourceConfirmationStatus,
  UserAccount,
} from '../types';
import { hasPermission } from '../utils/domainLogic';
import { apiFetch } from '../utils/api';

interface AssignmentsViewProps {
  user: UserAccount;
  courses: Course[];
  assignments: Assignment[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const CONFIRMATION_LABELS: Record<SourceConfirmationStatus, string> = {
  confirmed_instructor: 'مؤكد رسمياً من أستاذ المقرر',
  confirmed_rep: 'مؤكد وموثق عبر المندوب / المنسق',
  unconfirmed_student: 'بلاغ طلابي قيد التحقق',
};

const GENERAL_STATUS_LABELS: Record<string, string> = {
  active: 'ساري للتسليم',
  extended: 'تم تمديد الموعد',
  completed: 'انتهى موعد التسليم',
  cancelled: 'تكليف ملغى',
};

export const AssignmentsView: React.FC<AssignmentsViewProps> = ({
  user,
  courses,
  assignments,
  onRefresh,
  notify,
}) => {
  const canManage = hasPermission(user, 'assignments');
  const [searchQuery, setSearchQuery] = useState('');
  const [courseFilter, setCourseFilter] = useState('ALL');
  const [progressFilter, setProgressFilter] = useState<'ALL' | PersonalProgressStatus>('ALL');
  const [sortBy, setSortBy] = useState<'dueDate' | 'course'>('dueDate');
  const [showAddModal, setShowAddModal] = useState(false);

  // Add assignment form
  const [courseId, setCourseId] = useState(courses[0]?.id || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [instructor, setInstructor] = useState(courses[0]?.instructor || '');
  const [dueDate, setDueDate] = useState('2026-12-01');
  const [targetGroup, setTargetGroup] = useState('ALL');
  const [confirmationStatus, setConfirmationStatus] =
    useState<SourceConfirmationStatus>('confirmed_instructor');
  const [sourceNote, setSourceNote] = useState('');
  const [attachmentName, setAttachmentName] = useState('');

  const handleUpdatePersonalProgress = async (
    assignmentId: string,
    personalStatus: PersonalProgressStatus
  ) => {
    try {
      await apiFetch(`/api/assignments/${assignmentId}/progress`, {
        method: 'PUT',
        body: JSON.stringify({ personalStatus }),
      });
      notify('تم تحديث حالة تقدمك الشخصية في التكليف');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر التحديث', 'error');
    }
  };

  const handleUpdateGeneralStatus = async (assignmentId: string, generalStatus: string) => {
    try {
      await apiFetch(`/api/assignments/${assignmentId}/status`, {
        method: 'PUT',
        body: JSON.stringify({ generalStatus }),
      });
      notify('تم تحديث الحالة العامة للتكليف');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تحديث الحالة العامة', 'error');
    }
  };

  const handleCreateAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/assignments', {
        method: 'POST',
        body: JSON.stringify({
          courseId,
          title,
          description,
          instructor,
          dueDate,
          targetGroup,
          confirmationStatus,
          sourceNote,
          attachmentName: attachmentName || undefined,
        }),
      });
      notify('تم نشر التكليف الدراسي بنجاح');
      setTitle('');
      setDescription('');
      setSourceNote('');
      setAttachmentName('');
      setShowAddModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر نشر التكليف', 'error');
    }
  };

  const filtered = assignments
    .filter((a) => {
      if (courseFilter !== 'ALL' && a.courseId !== courseFilter) return false;
      if (progressFilter !== 'ALL' && (a.personalStatus || 'not_started') !== progressFilter)
        return false;
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        return (
          a.title.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q) ||
          (a.courseNameAr || '').toLowerCase().includes(q)
        );
      }
      return true;
    })
    .sort((a, b) => {
      if (sortBy === 'dueDate') return a.dueDate.localeCompare(b.dueDate);
      return (a.courseNameAr || '').localeCompare(b.courseNameAr || '');
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            إدارة التكاليف الدراسية ومتابعة الإنجاز
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            توثيق التكاليف المعتمدة مع فصل كامل بين الحالة العامة للتكليف وحالة تقدمك الشخصية.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={() => {
              setCourseId(courses[0]?.id || '');
              setInstructor(courses[0]?.instructor || '');
              setShowAddModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap self-start md:self-auto"
          >
            <Plus className="w-4 h-4" />
            <span>نشر تكليف جديد</span>
          </button>
        )}
      </div>

      {/* Filters & Search Bar */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث في عنوان التكليف أو الوصف..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 pr-9 pl-3 py-2 text-xs"
          />
        </div>

        <select
          value={courseFilter}
          onChange={(e) => setCourseFilter(e.target.value)}
          aria-label="تصفية حسب المقرر"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="ALL">جميع المقررات الدراسية</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nameAr} ({c.code})
            </option>
          ))}
        </select>

        <select
          value={progressFilter}
          onChange={(e) => setProgressFilter(e.target.value as 'ALL' | PersonalProgressStatus)}
          aria-label="تصفية حسب حالة التقدم الشخصية"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="ALL">جميع حالات تقدمي الشخصية</option>
          <option value="not_started">لم أبدأ بعد</option>
          <option value="in_progress">قيد التنفيذ</option>
          <option value="completed">مكتمل شخصياً</option>
        </select>

        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as 'dueDate' | 'course')}
          aria-label="ترتيب التكاليف"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="dueDate">الترتيب حسب موعد التسليم</option>
          <option value="course">الترتيب حسب المادة</option>
        </select>
      </div>

      {/* Assignments List */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 text-center">
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            لا توجد تكاليف مطابقة لمعايير البحث الحالية.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filtered.map((asg) => {
            const pStatus = asg.personalStatus || 'not_started';
            return (
              <div
                key={asg.id}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-teal-700 dark:text-teal-400">
                      {asg.courseNameAr} ({asg.courseCode})
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>المدرس: {asg.instructor}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      الفئة:{' '}
                      {asg.targetGroup === 'ALL' ? 'الدفعة كاملة' : `مجموعة ${asg.targetGroup}`}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 font-mono tabular-nums">
                    <span>نُشر: {asg.publishedAt}</span>
                    <span aria-hidden="true">·</span>
                    <span className="font-bold text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5" />
                      موعد التسليم: {asg.dueDate}
                    </span>
                  </div>
                </div>

                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-2">
                  {asg.title}
                </h3>
                <p className="text-sm text-slate-700 dark:text-slate-300 mt-1.5 leading-relaxed">
                  {asg.description}
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-slate-500 dark:text-slate-400">
                  <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300">
                    <ShieldCheck className="w-3.5 h-3.5 text-teal-600" />
                    {CONFIRMATION_LABELS[asg.confirmationStatus]}
                    {asg.sourceNote ? ` (${asg.sourceNote})` : ''}
                  </span>
                  {asg.attachmentName && (
                    <span className="inline-flex items-center gap-1 font-mono text-teal-700 dark:text-teal-400">
                      <FileText className="w-3.5 h-3.5" />
                      مرفق: {asg.attachmentName}
                    </span>
                  )}
                  <span>نشر بواسطة: {asg.creatorName || 'منسق التكاليف'}</span>
                </div>

                {/* Separated Personal Progress vs General Status Controls */}
                <div className="mt-4 pt-3.5 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                      حالة تقدمي الشخصية:
                    </span>
                    <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                      <button
                        type="button"
                        onClick={() => handleUpdatePersonalProgress(asg.id, 'not_started')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                          pStatus === 'not_started'
                            ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        لم أبدأ
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUpdatePersonalProgress(asg.id, 'in_progress')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                          pStatus === 'in_progress'
                            ? 'bg-amber-600 text-white shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        قيد التنفيذ
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUpdatePersonalProgress(asg.id, 'completed')}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1 ${
                          pStatus === 'completed'
                            ? 'bg-teal-600 text-white shadow-sm'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        <span>مكتمل</span>
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-slate-500">الحالة العامة للدفعة:</span>
                    {canManage ? (
                      <select
                        value={asg.generalStatus}
                        onChange={(e) => handleUpdateGeneralStatus(asg.id, e.target.value)}
                        aria-label={`الحالة العامة لتكليف ${asg.title}`}
                        className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1 text-xs font-semibold"
                      >
                        <option value="active">ساري للتسليم</option>
                        <option value="extended">مُمدّد الموعد</option>
                        <option value="completed">منتهي</option>
                        <option value="cancelled">ملغى</option>
                      </select>
                    ) : (
                      <strong className="text-slate-800 dark:text-slate-200">
                        {GENERAL_STATUS_LABELS[asg.generalStatus]}
                      </strong>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add Assignment Modal */}
      {showAddModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-assignment-title"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="add-assignment-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              نشر تكليف دراسي جديد
            </h3>
            <form onSubmit={handleCreateAssignment} className="mt-4 space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">المادة الدراسية</label>
                  <select
                    value={courseId}
                    onChange={(e) => {
                      setCourseId(e.target.value);
                      const c = courses.find((item) => item.id === e.target.value);
                      if (c) setInstructor(c.instructor);
                    }}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    {courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.nameAr} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">موعد التسليم النهائي</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">عنوان التكليف</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="مثال: التكليف العملي الثالث - قواعد البيانات"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">وصف ومتطلبات التكليف</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  placeholder="اشرح المطلوب وطريقة التسليم المعتمدة لدى أستاذ المقرر..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">المجموعة المستهدفة</label>
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
                <div>
                  <label className="block font-semibold mb-1">حالة تأكيد المصدر</label>
                  <select
                    value={confirmationStatus}
                    onChange={(e) =>
                      setConfirmationStatus(e.target.value as SourceConfirmationStatus)
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="confirmed_instructor">مؤكد من أستاذ المقرر</option>
                    <option value="confirmed_rep">مؤكد من المندوب / المنسق</option>
                    <option value="unconfirmed_student">معلومة طلابية قيد التأكيد</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">ملاحظة المصدر / المرفق المرجعي</label>
                <input
                  type="text"
                  value={sourceNote}
                  onChange={(e) => setSourceNote(e.target.value)}
                  placeholder="مثال: تم التكليف في نهاية محاضرة يوم الإثنين..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

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
                  نشر التكليف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
