import React, { useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  Clock,
  MapPin,
  Plus,
  Printer,
  Trash2,
  User,
  Edit3,
  BookOpen,
} from 'lucide-react';
import type { Course, Lecture, LectureStatus, ScheduleConflict, UserAccount } from '../types';
import { DAY_NAMES_AR, hasPermission } from '../utils/domainLogic';
import { apiFetch } from '../utils/api';

interface ScheduleViewProps {
  user: UserAccount;
  courses: Course[];
  lectures: Lecture[];
  conflicts: ScheduleConflict[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const STATUS_META: Record<
  LectureStatus,
  { label: string; borderClass: string; badgeText: string }
> = {
  official: {
    label: 'جدول معتمد',
    borderClass: 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900',
    badgeText: 'معتمد رسمياً',
  },
  confirmed_temp: {
    label: 'تغيير مؤقت مؤكد',
    borderClass: 'border-amber-300 dark:border-amber-700 bg-amber-50/40 dark:bg-amber-950/20',
    badgeText: 'تغيير مؤقت مؤكد',
  },
  proposed: {
    label: 'تغيير مقترح (غير معتمد بعد)',
    borderClass: 'border-dashed border-teal-400 dark:border-teal-700 bg-teal-50/30 dark:bg-teal-950/20',
    badgeText: 'مقترح تعديل (لا يغير الجدول الرسمي)',
  },
  cancelled: {
    label: 'ملغاة',
    borderClass: 'border-rose-200 dark:border-rose-900/50 bg-rose-50/30 dark:bg-rose-950/20 opacity-75',
    badgeText: 'محاضرة ملغاة',
  },
};

export const ScheduleView: React.FC<ScheduleViewProps> = ({
  user,
  courses,
  lectures,
  conflicts,
  onRefresh,
  notify,
}) => {
  const canEdit = hasPermission(user, 'lectures');
  const [viewMode, setViewMode] = useState<'weekly' | 'daily' | 'courses'>('weekly');
  const [selectedDay, setSelectedDay] = useState<number>(0);
  const [groupFilter, setGroupFilter] = useState<string>(
    user.role === 'student' ? user.groupName : 'ALL'
  );
  const [showLectureModal, setShowLectureModal] = useState(false);
  const [editingLecture, setEditingLecture] = useState<Lecture | null>(null);
  const [showCourseModal, setShowCourseModal] = useState(false);

  // Lecture form state
  const [courseId, setCourseId] = useState(courses[0]?.id || '');
  const [dayOfWeek, setDayOfWeek] = useState(0);
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('10:00');
  const [location, setLocation] = useState('');
  const [instructor, setInstructor] = useState('');
  const [targetGroup, setTargetGroup] = useState('ALL');
  const [lectureType, setLectureType] = useState<'lecture' | 'lab' | 'tutorial'>('lecture');
  const [status, setStatus] = useState<LectureStatus>('official');
  const [notes, setNotes] = useState('');

  // Course form state
  const [courseCode, setCourseCode] = useState('');
  const [courseNameAr, setCourseNameAr] = useState('');
  const [courseNameEn, setCourseNameEn] = useState('');
  const [courseInstructor, setCourseInstructor] = useState('');
  const [creditHours, setCreditHours] = useState(3);

  const openAddLecture = () => {
    setEditingLecture(null);
    const defaultCourse = courses[0];
    setCourseId(defaultCourse?.id || '');
    setDayOfWeek(0);
    setStartTime('08:00');
    setEndTime('10:00');
    setLocation('مدرج 101');
    setInstructor(defaultCourse?.instructor || '');
    setTargetGroup('ALL');
    setLectureType('lecture');
    setStatus('official');
    setNotes('');
    setShowLectureModal(true);
  };

  const openEditLecture = (lec: Lecture) => {
    setEditingLecture(lec);
    setCourseId(lec.courseId);
    setDayOfWeek(lec.dayOfWeek);
    setStartTime(lec.startTime);
    setEndTime(lec.endTime);
    setLocation(lec.location);
    setInstructor(lec.instructor);
    setTargetGroup(lec.targetGroup);
    setLectureType(lec.lectureType);
    setStatus(lec.status);
    setNotes(lec.notes);
    setShowLectureModal(true);
  };

  const handleSaveLecture = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const payload = {
        courseId,
        dayOfWeek,
        startTime,
        endTime,
        location,
        instructor,
        targetGroup,
        lectureType,
        status,
        notes,
      };
      if (editingLecture) {
        await apiFetch(`/api/lectures/${editingLecture.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        notify('تم تحديث بيانات المحاضرة بنجاح');
      } else {
        await apiFetch('/api/lectures', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        notify('تمت إضافة المحاضرة إلى الجدول');
      }
      setShowLectureModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'حدث خطأ', 'error');
    }
  };

  const handleDeleteLecture = async (id: string) => {
    try {
      await apiFetch(`/api/lectures/${id}`, { method: 'DELETE' });
      notify('تم حذف المحاضرة من الجدول');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر الحذف', 'error');
    }
  };

  const handleSaveCourse = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/courses', {
        method: 'POST',
        body: JSON.stringify({
          code: courseCode,
          nameAr: courseNameAr,
          nameEn: courseNameEn || courseNameAr,
          instructor: courseInstructor,
          creditHours,
        }),
      });
      notify('تمت إضافة المقرر الدراسي بنجاح');
      setCourseCode('');
      setCourseNameAr('');
      setCourseNameEn('');
      setCourseInstructor('');
      setShowCourseModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر إضافة المقرر', 'error');
    }
  };

  const filteredLectures = lectures.filter((l) => {
    if (groupFilter === 'ALL') return true;
    return l.targetGroup === 'ALL' || l.targetGroup === groupFilter;
  });

  const days = [0, 1, 2, 3, 4, 5];

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="no-print flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            الجدول الدراسي والمقررات الأكاديمية
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            ميز بصرياً بين الجدول الرسمي المعتمد والتغييرات المؤقتة المؤكدة والمقترحات قيد التنسيق.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* View Mode Switcher */}
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setViewMode('weekly')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                viewMode === 'weekly'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              عرض أسبوعي
            </button>
            <button
              type="button"
              onClick={() => setViewMode('daily')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                viewMode === 'daily'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              عرض يومي
            </button>
            <button
              type="button"
              onClick={() => setViewMode('courses')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                viewMode === 'courses'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              المقررات ({courses.length})
            </button>
          </div>

          {/* Group Filter */}
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setGroupFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                groupFilter === 'ALL'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              كل المجموعات
            </button>
            <button
              type="button"
              onClick={() => setGroupFilter('A')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                groupFilter === 'A'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              مجموعة A
            </button>
            <button
              type="button"
              onClick={() => setGroupFilter('B')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                groupFilter === 'B'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              مجموعة B
            </button>
          </div>

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap"
          >
            <Printer className="w-3.5 h-3.5" />
            <span>طباعة / PDF</span>
          </button>

          {canEdit && (
            <>
              <button
                type="button"
                onClick={() => setShowCourseModal(true)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-teal-600 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/40 transition-colors whitespace-nowrap"
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>إضافة مقرر</span>
              </button>
              <button
                type="button"
                onClick={openAddLecture}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>إضافة محاضرة</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Legend Bar */}
      <div className="flex flex-wrap items-center gap-6 text-xs text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800">
        <span className="font-semibold text-slate-900 dark:text-slate-200">دليل حالات الجدول:</span>
        <span>• معتمد رسمياً: الجدول الثابت من القسم</span>
        <span className="text-amber-700 dark:text-amber-400 font-medium">
          • تغيير مؤقت مؤكد: تعديل قاعة أو وقت معتمد لهذا الأسبوع
        </span>
        <span className="text-teal-700 dark:text-teal-400 font-medium">
          • مقترح تعديل: مقترح قيد التنسيق (لا يغير الجدول الرسمي تلقائياً)
        </span>
        <span className="text-rose-700 dark:text-rose-400 font-medium">• محاضرة ملغاة: معتذر عنها</span>
      </div>

      {/* Conflict Alert Banner */}
      {conflicts.length > 0 && (
        <div
          className="rounded-xl border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 p-4"
          role="alert"
        >
          <div className="flex items-center gap-2 text-rose-800 dark:text-rose-300 font-bold text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>تنبيه كاشف التعارضات الزمنية ({conflicts.length} تعارض مكتشف):</span>
          </div>
          <ul className="mt-2 space-y-1 text-xs text-rose-700 dark:text-rose-300 list-disc list-inside">
            {conflicts.map((c, idx) => (
              <li key={idx}>{c.descriptionAr}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Courses Sub-view */}
      {viewMode === 'courses' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {courses.map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-mono font-semibold text-teal-700 dark:text-teal-400">
                    {c.code}
                  </span>
                  <span className="tabular-nums">{c.creditHours} ساعات معتمدة</span>
                </div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-1.5">
                  {c.nameAr}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">{c.nameEn}</p>
                <p className="text-xs text-slate-700 dark:text-slate-300 mt-3">
                  أستاذ المقرر: <strong>{c.instructor}</strong>
                </p>
              </div>
              {canEdit && (
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch(`/api/courses/${c.id}`, { method: 'DELETE' });
                      notify('تم حذف المقرر');
                      await onRefresh();
                    }}
                    className="text-xs text-rose-600 hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف المقرر</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Daily selector bar when in daily mode */}
      {viewMode === 'daily' && (
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {days.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setSelectedDay(d)}
              className={`px-4 py-2 text-xs font-bold rounded-lg border transition-colors whitespace-nowrap ${
                selectedDay === d
                  ? 'bg-slate-900 dark:bg-teal-600 text-white border-transparent'
                  : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-800'
              }`}
            >
              {DAY_NAMES_AR[d]}
            </button>
          ))}
        </div>
      )}

      {/* Schedule Grid */}
      {viewMode !== 'courses' && (
        <div className="space-y-4">
          {(viewMode === 'weekly' ? days : [selectedDay]).map((dayIndex) => {
            const dayLectures = filteredLectures.filter((l) => l.dayOfWeek === dayIndex);
            return (
              <div
                key={dayIndex}
                className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden"
              >
                <div className="px-5 py-3 bg-slate-100/80 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                    <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      يوم {DAY_NAMES_AR[dayIndex]}
                    </h2>
                  </div>
                  <span className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    {dayLectures.length} محاضرات مجدولة
                  </span>
                </div>

                {dayLectures.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">
                    لا توجد محاضرات مجدولة في هذا اليوم للمجموعة المحددة.
                  </div>
                ) : (
                  <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {dayLectures.map((lec) => {
                      const meta = STATUS_META[lec.status] || STATUS_META.official;
                      const hasConflict = conflicts.some(
                        (c) => c.lectureAId === lec.id || c.lectureBId === lec.id
                      );
                      return (
                        <div
                          key={lec.id}
                          className={`rounded-xl border p-4 transition-all ${meta.borderClass} ${
                            hasConflict ? 'ring-2 ring-rose-500' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-1">
                              <Clock className="w-3.5 h-3.5 text-teal-600" />
                              {lec.startTime} – {lec.endTime}
                            </span>
                            <span>
                              {lec.targetGroup === 'ALL'
                                ? 'الدفعة كاملة'
                                : `مجموعة ${lec.targetGroup}`}{' '}
                              ·{' '}
                              {lec.lectureType === 'lab'
                                ? 'معمل عملي'
                                : lec.lectureType === 'tutorial'
                                ? 'تمارين'
                                : 'محاضرة'}
                            </span>
                          </div>

                          <h3
                            className={`text-base font-bold mt-2 ${
                              lec.status === 'cancelled'
                                ? 'line-through text-slate-400'
                                : 'text-slate-900 dark:text-slate-100'
                            }`}
                          >
                            {lec.courseNameAr || 'مقرر دراسي'}{' '}
                            {lec.courseCode ? (
                              <span className="text-xs font-mono font-normal text-slate-500">
                                ({lec.courseCode})
                              </span>
                            ) : null}
                          </h3>

                          <div className="mt-2.5 space-y-1 text-xs text-slate-600 dark:text-slate-300">
                            <p className="flex items-center gap-1.5">
                              <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{lec.location}</span>
                            </p>
                            <p className="flex items-center gap-1.5">
                              <User className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                              <span>{lec.instructor}</span>
                            </p>
                          </div>

                          {lec.notes && (
                            <p className="mt-2.5 pt-2 border-t border-slate-200/70 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-400">
                              {lec.notes}
                            </p>
                          )}

                          <div className="mt-3 pt-2.5 border-t border-slate-200/70 dark:border-slate-800 flex items-center justify-between text-xs">
                            <span
                              className={`font-semibold ${
                                lec.status === 'confirmed_temp'
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : lec.status === 'proposed'
                                  ? 'text-teal-700 dark:text-teal-400'
                                  : lec.status === 'cancelled'
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {meta.badgeText}
                            </span>

                            {canEdit && (
                              <div className="no-print flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => openEditLecture(lec)}
                                  className="text-slate-600 dark:text-slate-300 hover:text-teal-600 inline-flex items-center gap-1"
                                  aria-label={`تعديل محاضرة ${lec.courseNameAr}`}
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                  <span>تعديل</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteLecture(lec.id)}
                                  className="text-rose-600 hover:text-rose-700 inline-flex items-center gap-1"
                                  aria-label={`حذف محاضرة ${lec.courseNameAr}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / Edit Lecture Modal */}
      {showLectureModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lecture-modal-title"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="lecture-modal-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              {editingLecture ? 'تعديل بيانات وحالة المحاضرة' : 'إضافة محاضرة جديدة للجدول'}
            </h3>
            <form onSubmit={handleSaveLecture} className="mt-4 space-y-3.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    المقرر الدراسي
                  </label>
                  <select
                    value={courseId}
                    onChange={(e) => {
                      setCourseId(e.target.value);
                      const found = courses.find((c) => c.id === e.target.value);
                      if (found && !editingLecture) setInstructor(found.instructor);
                    }}
                    required
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
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    اليوم الدراسي
                  </label>
                  <select
                    value={dayOfWeek}
                    onChange={(e) => setDayOfWeek(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    {days.map((d) => (
                      <option key={d} value={d}>
                        {DAY_NAMES_AR[d]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    وقت البداية
                  </label>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    وقت النهاية
                  </label>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    المجموعة المستهدفة
                  </label>
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    القاعة أو المعمل
                  </label>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    required
                    placeholder="مثال: مدرج 101 أو معمل B2"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    المحاضر / المدرس
                  </label>
                  <input
                    type="text"
                    value={instructor}
                    onChange={(e) => setInstructor(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    نوع الجلسة
                  </label>
                  <select
                    value={lectureType}
                    onChange={(e) =>
                      setLectureType(e.target.value as 'lecture' | 'lab' | 'tutorial')
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="lecture">محاضرة نظرية</option>
                    <option value="lab">معمل عملي</option>
                    <option value="tutorial">جلسة تمارين</option>
                  </select>
                </div>

                <div>
                  <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                    حالة الاعتماد في الجدول
                  </label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as LectureStatus)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="official">جدول رسمي معتمد</option>
                    <option value="confirmed_temp">تغيير مؤقت مؤكد</option>
                    <option value="proposed">تغيير مقترح (لا يغير الرسمي تلقائياً)</option>
                    <option value="cancelled">إلغاء المحاضرة</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1 text-slate-700 dark:text-slate-300">
                  ملاحظات توضيحية للطلاب
                </label>
                <input
                  type="text"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="مثال: تعويض محاضرة الأسبوع الماضي..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div className="pt-3 flex items-center justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowLectureModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold hover:bg-teal-700"
                >
                  حفظ المحاضرة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Course Modal */}
      {showCourseModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="course-modal-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="course-modal-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              إضافة مقرر دراسي جديد
            </h3>
            <form onSubmit={handleSaveCourse} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">رمز المقرر (Code)</label>
                <input
                  type="text"
                  value={courseCode}
                  onChange={(e) => setCourseCode(e.target.value)}
                  required
                  placeholder="مثال: CS201"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">اسم المقرر بالعربية</label>
                <input
                  type="text"
                  value={courseNameAr}
                  onChange={(e) => setCourseNameAr(e.target.value)}
                  required
                  placeholder="مثال: هياكل البيانات والخوارزميات"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">اسم المقرر بالإنجليزية</label>
                <input
                  type="text"
                  value={courseNameEn}
                  onChange={(e) => setCourseNameEn(e.target.value)}
                  placeholder="Data Structures & Algorithms"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">مدرس المقرر</label>
                  <input
                    type="text"
                    value={courseInstructor}
                    onChange={(e) => setCourseInstructor(e.target.value)}
                    required
                    placeholder="د. محمد..."
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">الساعات المعتمدة</label>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    value={creditHours}
                    onChange={(e) => setCreditHours(Number(e.target.value))}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 tabular-nums"
                  />
                </div>
              </div>
              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCourseModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  حفظ المقرر
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
