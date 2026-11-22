import React, { useState } from 'react';
import {
  Download,
  FolderOpen,
  LayoutGrid,
  List,
  MessageSquare,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  CohortTask,
  Course,
  LibraryCategory,
  LibraryFile,
  TaskPriority,
  TaskStatus,
  UserAccount,
} from '../types';
import { hasPermission } from '../utils/domainLogic';
import { apiFetch, formatBytes, getAuthToken } from '../utils/api';

// ==========================================
// 1. TASKS MANAGEMENT VIEW (LIST & KANBAN)
// ==========================================

interface TasksViewProps {
  user: UserAccount;
  tasks: CohortTask[];
  staffMembers: UserAccount[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  new: 'جديدة',
  in_progress: 'قيد التنفيذ',
  awaiting_review: 'تنتظر مراجعة',
  completed: 'مكتملة',
  blocked: 'متوقفة',
};

const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'منخفضة',
  medium: 'متوسطة',
  high: 'عالية',
  urgent: 'عاجلة',
};

export const TasksView: React.FC<TasksViewProps> = ({
  user,
  tasks,
  staffMembers,
  onRefresh,
  notify,
}) => {
  const canDelegate = user.role === 'representative' || user.role === 'deputy';
  const [displayMode, setDisplayMode] = useState<'list' | 'kanban'>('list');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});

  // Task creation state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [assignedTo, setAssignedTo] = useState(staffMembers[0]?.id || user.id);
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [dueDate, setDueDate] = useState('2026-11-30');

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title,
          description,
          assignedTo,
          priority,
          dueDate,
        }),
      });
      notify('تم إنشاء المهمة وتفويضها للمسؤول بنجاح');
      setTitle('');
      setDescription('');
      setShowCreateModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر إنشاء المهمة', 'error');
    }
  };

  const handleUpdateTaskStatus = async (taskId: string, status: TaskStatus) => {
    try {
      await apiFetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify({ status }),
      });
      notify('تم تحديث حالة المهمة');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تحديث المهمة', 'error');
    }
  };

  const handleAddComment = async (taskId: string) => {
    const content = (commentInputs[taskId] || '').trim();
    if (!content) return;
    try {
      await apiFetch(`/api/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setCommentInputs((prev) => ({ ...prev, [taskId]: '' }));
      notify('تمت إضافة التعليق');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر إضافة التعليق', 'error');
    }
  };

  const statuses: TaskStatus[] = [
    'new',
    'in_progress',
    'awaiting_review',
    'completed',
    'blocked',
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            إدارة المهام وتوزيع المسؤوليات
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            تفويض المهام بين المندوب والنائب والمنسقين ومتابعة الإنجاز دون تركيز العبء على شخص واحد.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setDisplayMode('list')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md inline-flex items-center gap-1 transition-colors ${
                displayMode === 'list'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>عرض قائمة</span>
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode('kanban')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md inline-flex items-center gap-1 transition-colors ${
                displayMode === 'kanban'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span>لوحة Kanban</span>
            </button>
          </div>

          {canDelegate && (
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>تفويض مهمة جديدة</span>
            </button>
          )}
        </div>
      </div>

      {displayMode === 'list' ? (
        <div className="space-y-4">
          {tasks.map((tsk) => (
            <div
              key={tsk.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-teal-700 dark:text-teal-400">
                    المسؤول: {tsk.assigneeName || tsk.assignedTo}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>الأولوية: {TASK_PRIORITY_LABELS[tsk.priority]}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">الموعد النهائي: {tsk.dueDate}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span>الحالة:</span>
                  <select
                    value={tsk.status}
                    onChange={(e) =>
                      handleUpdateTaskStatus(tsk.id, e.target.value as TaskStatus)
                    }
                    aria-label={`تغيير حالة المهمة ${tsk.title}`}
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-900 dark:text-slate-100"
                  >
                    {statuses.map((st) => (
                      <option key={st} value={st}>
                        {TASK_STATUS_LABELS[st]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-2">
                {tsk.title}
              </h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 mt-1">{tsk.description}</p>

              {/* Comments Section */}
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                {tsk.comments && tsk.comments.length > 0 && (
                  <div className="space-y-1.5">
                    {tsk.comments.map((c) => (
                      <div
                        key={c.id}
                        className="text-xs bg-slate-50 dark:bg-slate-800/60 p-2.5 rounded-lg flex items-start justify-between gap-2"
                      >
                        <div>
                          <strong className="text-slate-800 dark:text-slate-200">
                            {c.authorName}:{' '}
                          </strong>
                          <span className="text-slate-700 dark:text-slate-300">{c.content}</span>
                        </div>
                        <span className="text-[11px] font-mono text-slate-400 shrink-0">
                          {c.createdAt.slice(0, 10)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <MessageSquare className="w-4 h-4 text-slate-400 shrink-0" />
                  <input
                    type="text"
                    value={commentInputs[tsk.id] || ''}
                    onChange={(e) =>
                      setCommentInputs((prev) => ({ ...prev, [tsk.id]: e.target.value }))
                    }
                    placeholder="أضف تعليقاً أو تحديثاً حول تقدم المهمة..."
                    className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-1.5 text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => handleAddComment(tsk.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-700 text-white hover:opacity-90"
                  >
                    إرسال
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
          {statuses.map((st) => {
            const colTasks = tasks.filter((t) => t.status === st);
            return (
              <div
                key={st}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-900/60 p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-2">
                  <h3 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    {TASK_STATUS_LABELS[st]}
                  </h3>
                  <span className="text-xs font-mono tabular-nums text-slate-500">
                    {colTasks.length}
                  </span>
                </div>
                {colTasks.map((tsk) => (
                  <div
                    key={tsk.id}
                    className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2"
                  >
                    <h4 className="text-xs font-bold text-slate-900 dark:text-slate-100">
                      {tsk.title}
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {tsk.assigneeName} · {tsk.dueDate}
                    </p>
                    <select
                      value={tsk.status}
                      onChange={(e) =>
                        handleUpdateTaskStatus(tsk.id, e.target.value as TaskStatus)
                      }
                      aria-label={`نقل المهمة ${tsk.title}`}
                      className="w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 text-[11px]"
                    >
                      {statuses.map((opt) => (
                        <option key={opt} value={opt}>
                          {TASK_STATUS_LABELS[opt]}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* Create Task Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-task-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="create-task-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              تفويض مهمة جديدة لفريق الدفعة
            </h3>
            <form onSubmit={handleCreateTask} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">عنوان المهمة</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="مثال: تنسيق موعد المحاضرة التعويضية..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">تفاصيل المهمة</label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">المسؤول المكلف</label>
                <select
                  value={assignedTo}
                  onChange={(e) => setAssignedTo(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                >
                  {staffMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.fullName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">الأولوية</label>
                  <select
                    value={priority}
                    onChange={(e) => setPriority(e.target.value as TaskPriority)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="low">منخفضة</option>
                    <option value="medium">متوسطة</option>
                    <option value="high">عالية</option>
                    <option value="urgent">عاجلة</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">الموعد النهائي</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  تفويض المهمة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

// ==========================================
// 2. LECTURE FILE LIBRARY VIEW (REAL DISK I/O)
// ==========================================

interface LibraryViewProps {
  user: UserAccount;
  courses: Course[];
  files: LibraryFile[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const LIBRARY_CATEGORY_LABELS: Record<LibraryCategory, string> = {
  lectures: 'محاضرات',
  summaries: 'ملخصات',
  assignments: 'تكاليف',
  references: 'مراجع',
  labs: 'ملفات عملية',
  other: 'ملفات أخرى',
};

export const LibraryView: React.FC<LibraryViewProps> = ({
  user,
  courses,
  files,
  onRefresh,
  notify,
}) => {
  const canUpload = hasPermission(user, 'files');
  const [courseFilter, setCourseFilter] = useState('ALL');
  const [catFilter, setCatFilter] = useState<'ALL' | LibraryCategory>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);

  // Upload state
  const [courseId, setCourseId] = useState(courses[0]?.id || '');
  const [category, setCategory] = useState<LibraryCategory>('lectures');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetGroup, setTargetGroup] = useState('ALL');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [selectedMimeType, setSelectedMimeType] = useState('text/plain');
  const [base64Content, setBase64Content] = useState('');

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    setSelectedMimeType(file.type || 'application/octet-stream');

    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      setBase64Content(base64);
    };
    reader.readAsDataURL(file);
  };

  const handleUploadSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!base64Content || !selectedFileName) {
      notify('يرجى اختيار ملف حقيقي من جهازك لرفعه إلى الخادم', 'error');
      return;
    }
    try {
      await apiFetch('/api/files', {
        method: 'POST',
        body: JSON.stringify({
          courseId,
          level: 'المستوى الأول - تقنية معلومات',
          category,
          title,
          description,
          fileName: selectedFileName,
          mimeType: selectedMimeType,
          base64Content,
          targetGroup,
        }),
      });
      notify('تم رفع الملف وتخزينه فعلياً في مكتبة المحاضرات');
      setTitle('');
      setDescription('');
      setSelectedFileName('');
      setBase64Content('');
      setShowUploadModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر رفع الملف', 'error');
    }
  };

  const handleDeleteFile = async (id: string) => {
    try {
      await apiFetch(`/api/files/${id}`, { method: 'DELETE' });
      notify('تم حذف الملف من المكتبة');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر حذف الملف', 'error');
    }
  };

  const filtered = files.filter((f) => {
    if (courseFilter !== 'ALL' && f.courseId !== courseFilter) return false;
    if (catFilter !== 'ALL' && f.category !== catFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        f.title.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.fileName.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const token = getAuthToken();

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            مكتبة المحاضرات والملفات الدراسية
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            تنظيم هرمي (المستوى الدراسي ← المادة ← نوع المحتوى) مع تخزين وتنزيل فعلي للملفات.
          </p>
        </div>

        {canUpload && (
          <button
            type="button"
            onClick={() => {
              setCourseId(courses[0]?.id || '');
              setShowUploadModal(true);
            }}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap self-start md:self-auto"
          >
            <Upload className="w-4 h-4" />
            <span>رفع ملف دراسي جديد</span>
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute right-3 top-2.5" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="بحث في عناوين الملفات أو أسمائها..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 pr-9 pl-3 py-2 text-xs"
          />
        </div>

        <select
          value={courseFilter}
          onChange={(e) => setCourseFilter(e.target.value)}
          aria-label="تصفية المكتبة حسب المادة"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="ALL">جميع المواد الدراسية</option>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nameAr} ({c.code})
            </option>
          ))}
        </select>

        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value as 'ALL' | LibraryCategory)}
          aria-label="تصفية المكتبة حسب نوع المحتوى"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="ALL">جميع أنواع المحتوى</option>
          <option value="lectures">محاضرات</option>
          <option value="summaries">ملخصات</option>
          <option value="labs">ملفات عملية</option>
          <option value="assignments">تكاليف</option>
          <option value="references">مراجع</option>
          <option value="other">ملفات أخرى</option>
        </select>
      </div>

      {/* Files Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((f) => (
          <div
            key={f.id}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between"
          >
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <div className="flex items-center gap-1.5">
                  <FolderOpen className="w-3.5 h-3.5 text-teal-600" />
                  <span>{f.level}</span>
                  <span aria-hidden="true">←</span>
                  <strong className="text-slate-800 dark:text-slate-200">{f.courseNameAr}</strong>
                  <span aria-hidden="true">←</span>
                  <span className="text-teal-700 dark:text-teal-400 font-semibold">
                    {LIBRARY_CATEGORY_LABELS[f.category]}
                  </span>
                </div>
                <span className="font-mono tabular-nums">{formatBytes(f.sizeBytes)}</span>
              </div>

              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-2">
                {f.title}
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 mt-1">{f.description}</p>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2 text-xs">
              <span className="font-mono text-slate-500 truncate max-w-[200px]">
                {f.fileName}
              </span>

              <div className="flex items-center gap-2">
                <a
                  href={`/api/files/${f.id}/download?token=${encodeURIComponent(token)}`}
                  download={f.fileName}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-teal-600 text-white font-semibold hover:opacity-90"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>تنزيل الملف</span>
                </a>
                {canUpload && (
                  <button
                    type="button"
                    onClick={() => handleDeleteFile(f.id)}
                    aria-label={`حذف ملف ${f.title}`}
                    className="p-1.5 rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Upload File Modal */}
      {showUploadModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="upload-file-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="upload-file-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              رفع ملف جديد إلى مكتبة المحاضرات
            </h3>
            <form onSubmit={handleUploadSubmit} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">المادة الدراسية</label>
                <select
                  value={courseId}
                  onChange={(e) => setCourseId(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                >
                  {courses.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameAr} ({c.code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">نوع المحتوى</label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value as LibraryCategory)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="lectures">محاضرات</option>
                    <option value="summaries">ملخصات</option>
                    <option value="labs">ملفات عملية</option>
                    <option value="assignments">تكاليف</option>
                    <option value="references">مراجع</option>
                    <option value="other">ملفات أخرى</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">المجموعة المسموح لها</label>
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
                <label className="block font-semibold mb-1">عنوان الملف</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  placeholder="مثال: المحاضرة الخامسة - المؤشرات في C++"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">وصف مختصر</label>
                <textarea
                  rows={2}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">
                  اختيار الملف (PDF, TXT, DOCX, PPTX, ZIP, صور — بحد أقصى 8MB)
                </label>
                <input
                  type="file"
                  onChange={handleFileInputChange}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  رفع وحفظ الملف
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
