import React from 'react';
import {
  AlertCircle,
  Bell,
  BookOpen,
  Calendar,
  CheckSquare,
  Clock,
  FileText,
  FolderOpen,
  PlusCircle,
  ThumbsUp,
  Users,
} from 'lucide-react';
import type {
  Announcement,
  Assignment,
  CohortRequest,
  CohortTask,
  Lecture,
  LibraryFile,
  UserAccount,
} from '../types';
import {
  DAY_NAMES_AR,
  REQUEST_STATUS_LABELS_AR,
  doGroupsOverlap,
} from '../utils/domainLogic';
import { ROLE_LABELS_AR } from '../utils/api';

interface DashboardViewProps {
  user: UserAccount;
  lectures: Lecture[];
  assignments: Assignment[];
  announcements: Announcement[];
  requests: CohortRequest[];
  tasks: CohortTask[];
  files: LibraryFile[];
  onNavigate: (tab: string) => void;
  onQuickEndorse: (requestId: string) => Promise<void>;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  user,
  lectures,
  assignments,
  announcements,
  requests,
  tasks,
  files,
  onNavigate,
  onQuickEndorse,
}) => {
  const isStaff =
    user.role === 'representative' ||
    user.role === 'deputy' ||
    user.role === 'coordinator';

  // Map JS getDay() (0=Sun..6=Sat) to our academic week (0=Sat, 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu)
  const jsDay = new Date().getDay();
  const academicToday = jsDay === 6 ? 0 : jsDay === 5 ? 0 : jsDay + 1;

  const myLectures = lectures.filter(
    (l) =>
      l.status !== 'cancelled' &&
      (isStaff || doGroupsOverlap(l.targetGroup, user.groupName))
  );

  const todaysLectures = myLectures.filter((l) => l.dayOfWeek === academicToday);
  const nextLectures = todaysLectures.length > 0 ? todaysLectures : myLectures.slice(0, 3);

  const upcomingAssignments = assignments
    .filter((a) => a.generalStatus === 'active' || a.generalStatus === 'extended')
    .slice(0, 4);

  const openForEndorsement = requests.filter(
    (r) => r.isCollective && r.status === 'open_for_endorsement'
  );
  const myPersonalRequests = requests.filter((r) => r.createdBy === user.id);
  const inProgressRequests = requests.filter((r) =>
    ['ready_for_submission', 'submitted', 'under_review'].includes(r.status)
  );

  const todayIso = new Date().toISOString().slice(0, 10);
  const overdueTasks = tasks.filter(
    (t) => t.status !== 'completed' && t.dueDate < todayIso
  );
  const activeTasks = tasks.filter((t) => t.status !== 'completed');

  return (
    <div className="space-y-6">
      {/* Top Welcome & Quick Actions Banner */}
      <div className="aurora-hero p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-white/75">
            <span className="px-2.5 py-0.5 rounded-full font-bold bg-[#1B193A]/75 text-[#5EEAD4] border border-[#14B8A6]/35">
              {ROLE_LABELS_AR[user.role]}
            </span>
            <span aria-hidden="true">·</span>
            <span>المجموعة الدراسية: {user.groupName}</span>
            <span aria-hidden="true">·</span>
            <span>
              الرقم الجامعي:{' '}
              <span className="font-mono tabular-nums font-semibold">{user.universityId}</span>
            </span>
            {user.isDemo && (
              <>
                <span aria-hidden="true">·</span>
                <span className="px-2 py-0.5 rounded-full bg-[#1B193A]/75 text-[#FCD34D] border border-[#F59E0B]/35 font-semibold">
                  بيئة تجربة تفاعلية
                </span>
              </>
            )}
          </div>
          <h1 className="text-2xl font-bold text-white mt-1.5 aurora-wrap">
            مرحباً بك، {user.fullName.replace(' - تجريبي)', ')')}
          </h1>
          <p className="text-sm text-white/80 mt-1 aurora-wrap">
            {isStaff
              ? 'لوحة قيادة الدفعة — تابع المحاضرات، الطلبات قيد المعالجة، وتفويض المهام لفريق المنسقين.'
              : 'لوحة الطالب الأكاديمية — تابع محاضرات مجموعتك، تقدمك في التكاليف، وأيّد الطلبات الجماعية.'}
          </p>
        </div>

        {/* Quick Action Shortcuts */}
        <div className="flex flex-wrap items-center gap-2">
          {isStaff ? (
            <>
              <button
                type="button"
                onClick={() => onNavigate('announcements')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap"
              >
                <PlusCircle className="w-4 h-4" />
                <span>نشر إعلان سريع</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('assignments')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border aurora-on-dark-btn transition-colors whitespace-nowrap"
              >
                <BookOpen className="w-4 h-4 text-[#5EEAD4]" />
                <span>إضافة تكليف</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('tasks')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border aurora-on-dark-btn transition-colors whitespace-nowrap"
              >
                <CheckSquare className="w-4 h-4 text-[#FCD34D]" />
                <span>تفويض مهمة</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onNavigate('requests')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap"
              >
                <PlusCircle className="w-4 h-4" />
                <span>تقديم طلب / مقترح</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('schedule')}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border aurora-on-dark-btn transition-colors whitespace-nowrap"
              >
                <Calendar className="w-4 h-4 text-[#E8E6FC]" />
                <span>جدول مجموعتي ({user.groupName})</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="aurora-card p-4 border-s-4 border-s-[#635BDB]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            محاضرات {DAY_NAMES_AR[academicToday]}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {todaysLectures.length}
            </span>
            <span className="text-xs text-teal-700 dark:text-teal-400">
              من أصل {myLectures.length} أسبوعياً
            </span>
          </div>
        </div>

        <div className="aurora-card p-4 border-s-4 border-s-[#14B8A6]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            التكاليف السارية
          </div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {upcomingAssignments.length}
            </span>
            <span className="text-xs text-[var(--aurora-teal-text)] aurora-wrap tabular-nums">
              {
                upcomingAssignments.filter((a) => a.personalStatus === 'completed')
                  .length
              }{' '}
              منجز شخصياً
            </span>
          </div>
        </div>

        <div className="aurora-card p-4 border-s-4 border-s-[#F59E0B]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            طلبات مفتوحة للتأييد
          </div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {openForEndorsement.length}
            </span>
            <span className="text-xs text-slate-500">
              {inProgressRequests.length} قيد المتابعة
            </span>
          </div>
        </div>

        <div className="aurora-card p-4 border-s-4 border-s-[#25234D] dark:border-s-[#A59FF7]">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {isStaff ? 'المهام المفوضة النشطة' : 'ملفات المكتبة الدراسية'}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {isStaff ? activeTasks.length : files.length}
            </span>
            <span className="text-xs text-rose-600 dark:text-rose-400">
              {isStaff
                ? `${overdueTasks.length} مهام متأخرة`
                : `${announcements.filter((a) => !a.isRead).length} إعلان غير مقروء`}
            </span>
          </div>
        </div>
      </div>

      {/* Main Two-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Right Column (7 cols): Schedule & Assignments */}
        <div className="lg:col-span-7 space-y-6">
          {/* Today's & Upcoming Lectures */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {todaysLectures.length > 0
                    ? `محاضرات اليوم (${DAY_NAMES_AR[academicToday]})`
                    : 'المحاضرات القادمة في الجدول'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('schedule')}
                className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
              >
                عرض الجدول الكامل
              </button>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {nextLectures.map((lec) => (
                <div
                  key={lec.id}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div>
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-semibold text-slate-800 dark:text-slate-200">
                        {DAY_NAMES_AR[lec.dayOfWeek]}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {lec.startTime} – {lec.endTime}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {lec.targetGroup === 'ALL'
                          ? 'الدفعة كاملة'
                          : `مجموعة ${lec.targetGroup}`}
                      </span>
                    </div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1">
                      {lec.courseNameAr} ({lec.courseCode})
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                      {lec.location} · {lec.instructor}
                    </p>
                  </div>

                  <div className="text-xs">
                    {lec.status === 'confirmed_temp' ? (
                      <span className="text-2xl font-bold text-slate-900 dark:text-slate-100 mt-1.5">
                        تغيير مؤقت مؤكد
                      </span>
                    ) : lec.status === 'proposed' ? (
                      <span className="text-teal-700 dark:text-teal-400 font-semibold">
                        تغيير مقترح
                      </span>
                    ) : (
                      <span className="text-slate-500">معتمد رسمياً</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Upcoming Assignments */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  التكاليف الدراسية القادمة
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('assignments')}
                className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
              >
                إدارة جميع التكاليف
              </button>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {upcomingAssignments.map((asg) => (
                <div key={asg.id} className="p-4">
                  <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span className="font-semibold text-teal-700 dark:text-teal-400">
                      {asg.courseNameAr}
                    </span>
                    <span className="font-mono tabular-nums inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 font-semibold">
                      <Clock className="w-3.5 h-3.5" />
                      التسليم: {asg.dueDate}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1">
                    {asg.title}
                  </h3>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>
                      حالة تقدمي:{' '}
                      <strong className="text-slate-800 dark:text-slate-200">
                        {asg.personalStatus === 'completed'
                          ? 'مكتمل'
                          : asg.personalStatus === 'in_progress'
                          ? 'قيد التنفيذ'
                          : 'لم أبدأ'}
                      </strong>
                    </span>
                    <span>
                      الفئة:{' '}
                      {asg.targetGroup === 'ALL'
                        ? 'الدفعة كاملة'
                        : `مجموعة ${asg.targetGroup}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Collective Requests Open for Endorsement */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  {isStaff
                    ? 'الطلبات الجماعية والشكاوى قيد المتابعة'
                    : 'طلبات جماعية متاحة لتأييدك الآن'}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('requests')}
                className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
              >
                عرض كل المعاملات ({requests.length})
              </button>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {requests.slice(0, 3).map((req) => (
                <div key={req.id} className="p-4 space-y-2">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span className="font-mono font-semibold">{req.referenceNumber}</span>
                    <span className="font-semibold text-teal-700 dark:text-teal-400">
                      {REQUEST_STATUS_LABELS_AR[req.status]}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    {req.subject}
                  </h3>
                  <div className="flex items-center justify-between text-xs pt-1">
                    <span className="text-slate-600 dark:text-slate-400 tabular-nums">
                      عدد المؤيدين: <strong className="font-mono">{req.endorsementCount}</strong>
                    </span>

                    {req.isCollective &&
                      req.status === 'open_for_endorsement' &&
                      !req.userHasEndorsed && (
                        <button
                          type="button"
                          onClick={() => onQuickEndorse(req.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-teal-600 text-white font-semibold hover:bg-teal-700"
                        >
                          <ThumbsUp className="w-3 h-3" />
                          <span>تأييد سريع</span>
                        </button>
                      )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Left Column (5 cols): Announcements, Delegated Tasks (or Student Requests & Library) */}
        <div className="lg:col-span-5 space-y-6">
          {/* Important Announcements */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-amber-600" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  أحدث الإعلانات والتنبيهات المهمة
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('announcements')}
                className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
              >
                كل الإعلانات
              </button>
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {announcements.slice(0, 3).map((ann) => (
                <div key={ann.id} className="p-4">
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span
                      className={
                        ann.priority === 'urgent'
                          ? 'font-bold text-rose-600 dark:text-rose-400'
                          : 'font-semibold text-teal-700 dark:text-teal-400'
                      }
                    >
                      {ann.priority === 'urgent' ? 'تنبيه عاجل' : 'إعلان مثبت'}
                    </span>
                    <span className="font-mono tabular-nums">
                      {ann.createdAt.slice(0, 10)}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1">
                    {ann.title}
                  </h3>
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">
                    {ann.content}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Role-Specific Secondary Panel */}
          {isStaff ? (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CheckSquare className="w-4 h-4 text-teal-600" />
                  <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    المهام المفوضة لفريق الدفعة
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('tasks')}
                  className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                >
                  إدارة المهام
                </button>
              </div>

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {tasks.map((tsk) => {
                  const isLate = tsk.status !== 'completed' && tsk.dueDate < todayIso;
                  return (
                    <div key={tsk.id} className="p-4">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span>المسؤول: {tsk.assigneeName}</span>
                        <span
                          className={`font-mono tabular-nums ${
                            isLate
                              ? 'text-rose-600 font-bold'
                              : 'text-slate-500'
                          }`}
                        >
                          {isLate ? `متأخرة (${tsk.dueDate})` : tsk.dueDate}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1">
                        {tsk.title}
                      </h3>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-teal-600" />
                  <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                    طلباتي ومعاملاتي الشخصية ({myPersonalRequests.length})
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('requests')}
                  className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
                >
                  متابعة الطلبات
                </button>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {myPersonalRequests.length === 0 ? (
                  <div className="p-5 text-xs text-slate-500 text-center">
                    لم تقم بتقديم طلبات شخصية بعد. يمكنك تقديم مقترح أو شكوى في أي وقت.
                  </div>
                ) : (
                  myPersonalRequests.map((r) => (
                    <div key={r.id} className="p-4">
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span className="font-mono">{r.referenceNumber}</span>
                        <span className="font-semibold text-teal-700 dark:text-teal-400">
                          {REQUEST_STATUS_LABELS_AR[r.status]}
                        </span>
                      </div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1">
                        {r.subject}
                      </h3>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Latest Lecture Library Files */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-teal-600" />
                <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  أحدث الملفات والملخصات الدراسية
                </h2>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('library')}
                className="text-xs font-semibold text-teal-700 dark:text-teal-400 hover:underline"
              >
                فتح المكتبة
              </button>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {files.slice(0, 3).map((f) => (
                <div key={f.id} className="p-4">
                  <div className="text-xs text-teal-700 dark:text-teal-400 font-semibold">
                    {f.courseNameAr}
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-0.5">
                    {f.title}
                  </h3>
                  <p className="text-xs font-mono text-slate-500 mt-1">{f.fileName}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
