import { csvCell } from '../utils/rosterCsv';
import React, { useEffect, useState } from 'react';
import {
  Database,
  Download,
  FileSpreadsheet,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Trash2,
  Upload,
  UserCheck,
  UserX,
  Edit3,
} from 'lucide-react';
import type { AuditLogEntry, ResponsibilityKey, UserAccount, UserRole } from '../types';
import { hasPermission } from '../utils/domainLogic';
import {
  RESPONSIBILITY_LABELS_AR,
  ROLE_LABELS_AR,
  apiFetch,
  buildApiUrl,
  getAuthToken,
} from '../utils/api';

interface AdminAndStudentsViewProps {
  user: UserAccount;
  members: UserAccount[];
  mode: 'students' | 'admin';
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const ALL_RESPONSIBILITY_KEYS: ResponsibilityKey[] = [
  'lectures',
  'assignments',
  'files',
  'announcements',
  'requests',
  'students',
  'permissions',
  'backup',
];

export const AdminAndStudentsView: React.FC<AdminAndStudentsViewProps> = ({
  user,
  members,
  mode,
  onRefresh,
  notify,
}) => {
  const canManageStudents = hasPermission(user, 'students');
  const isRepresentative = user.role === 'representative';

  const [searchQuery, setSearchQuery] = useState('');
  const [groupFilter, setGroupFilter] = useState('ALL');
  const [roleFilter, setRoleFilter] = useState('ALL');
  const [showAddUserModal, setShowAddUserModal] = useState(false);
  const [showCsvModal, setShowCsvModal] = useState(false);
  const [issueNewPassword, setIssueNewPassword] = useState(false);
  const [newCredential, setNewCredential] = useState('');
  const [editingMember, setEditingMember] = useState<UserAccount | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [confirmDemoPurge, setConfirmDemoPurge] = useState(false);

  // Add student state
  const [universityId, setUniversityId] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [groupName, setGroupName] = useState('A');
  const [role, setRole] = useState<UserRole>('student');
  const [responsibilities, setResponsibilities] = useState<ResponsibilityKey[]>([]);

  // CSV Import state
  const [csvText, setCsvText] = useState('');
  const [restorePassword, setRestorePassword] = useState('');


  useEffect(() => {
    if (mode === 'admin' && (isRepresentative || hasPermission(user, 'permissions'))) {
      setAuditLogsLoading(true);
      apiFetch<AuditLogEntry[]>('/api/admin/audit-logs')
        .then(setAuditLogs)
        .catch(() => setAuditLogs([])).finally(() => setAuditLogsLoading(false));
    }
  }, [mode, isRepresentative, user]);

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          universityId,
          fullName,
          email,
          password,
          groupName,
          role,
          responsibilities,
        }),
      });
      notify('تمت إضافة عضو الدفعة بنجاح');
      setUniversityId('');
      setFullName('');
      setEmail('');
      setPassword('');
      setShowAddUserModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر إضافة العضو', 'error');
    }
  };

  const handleUpdateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMember) return;
    try {
      const result = await apiFetch<{ initialPassword?: string }>(`/api/users/${editingMember.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          fullName: editingMember.fullName,
          groupName: editingMember.groupName,
          role: editingMember.role,
          responsibilities: editingMember.responsibilities,
          isActive: editingMember.isActive,
          resetPassword: issueNewPassword ? true : undefined,
        }),
      });
      notify('تم تحديث بيانات وصلاحيات العضو بنجاح');
      setEditingMember(null);
      setIssueNewPassword(false);
      setNewCredential(result.initialPassword || '');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر التحديث', 'error');
    }
  };

  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiFetch<{ imported: number; skipped: number; invitations: { universityId: string; initialPassword: string }[] }>('/api/users/import-csv', {
        method: 'POST',
        body: JSON.stringify({ csvText }),
      });
      notify(`تم استيراد ${res.imported} طالب بنجاح (وتخطي ${res.skipped} مكرر)`);
      if (res.invitations.length) {
        downloadCsv('DBL_Campus_Invitations.csv', [
          'university_id,initial_password',
          ...res.invitations.map(item => [item.universityId, item.initialPassword].map(csvCell).join(',')),
        ].join('\n'));
      }
      setCsvText('');
      setShowCsvModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر استيراد CSV', 'error');
    }
  };

  const downloadCsv = (filename: string, content: string) => {
    const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCsv = () => {
    const header = 'university_id,full_name,email,group_name,role,is_active';
    const rows = members.map(m => [m.universityId, m.fullName, m.email, m.groupName, m.role,
      m.isActive ? 'active' : 'disabled'].map(csvCell).join(','));
    downloadCsv(`DBL_Campus_Cohort_Roster_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...rows].join('\n'));
  };

  const handleDownloadBackup = async () => {
    try {
      const data = await apiFetch<Record<string, unknown>>('/api/admin/backup');
      const blob = new Blob([JSON.stringify(data)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DBL_Campus_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      notify('تم تصدير النسخة الاحتياطية الشاملة (JSON + SHA-256)');
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تصدير النسخة الاحتياطية', 'error');
    }
  };

  const handleDownloadSqliteBackup = async () => {
    try {
      const token = getAuthToken();
      const res = await fetch(buildApiUrl('/api/admin/backup/sqlite'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'تعذر تصدير قاعدة البيانات الثنائية');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `DBL_Campus_Database_${new Date().toISOString().slice(0, 10)}.sqlite`;
      a.click();
      URL.revokeObjectURL(url);
      notify('تم تصدير نسخة قاعدة البيانات الثنائية (SQLite) بنجاح');
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تصدير النسخة الثنائية', 'error');
    }
  };

  const handleRestoreBackupFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !restorePassword || !window.confirm('ستُستبدل بيانات الدفعة وتُغلق الجلسات. هل تريد المتابعة؟')) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        await apiFetch('/api/admin/restore', {
          method: 'POST',
          body: JSON.stringify({ ...parsed, currentPassword: restorePassword }),
        });
        notify('تمت استعادة النسخة الاحتياطية بنجاح');
        window.location.reload();
      } catch (err: unknown) {
        notify(
          err instanceof Error ? err.message : 'ملف النسخة الاحتياطية غير صالح',
          'error'
        );
      }
    };
    reader.readAsText(file);
  };

  if (mode === 'admin') {
    return (
      <div className="space-y-6">
        <div className="border-b border-slate-200 dark:border-slate-800 pb-5">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            النسخ الاحتياطي، سجل العمليات، وإدارة البيئة التجريبية
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            حفظ واستعادة قاعدة البيانات المحلية، مراجعة سجل التدقيق الأمني، وفصل البيانات التجريبية عن الاستخدام الفعلي.
          </p>
        </div>

        {/* Backup & Restore + Demo Environment Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {isRepresentative && <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-slate-100">
              <Database className="w-5 h-5 text-teal-600" />
              <h2>النسخ الاحتياطي والاستعادة (Backup & Restore)</h2>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              قم بتصدير نسخة احتياطية كاملة بصيغة JSON (محمية ببصمة SHA-256) أو نسخة SQLite ثنائية ذرية جاهزة للنقل بين الخوادم السحابية، أو استعد نسخة سابقة.
            </p>
            <label className="block text-xs">
              كلمة المرور الحالية للاستعادة
              <input type="password" autoComplete="current-password" value={restorePassword}
                onChange={event => setRestorePassword(event.target.value)} className="block mt-1 rounded border px-2 py-1" />
            </label>
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleDownloadBackup}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700"
              >
                <Download className="w-4 h-4" />
                <span>تصدير نسخة JSON شاملة</span>
              </button>

              <button
                type="button"
                onClick={handleDownloadSqliteBackup}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-slate-700 text-white hover:opacity-90"
              >
                <Database className="w-4 h-4" />
                <span>تنزيل قاعدة البيانات (.sqlite)</span>
              </button>

              <label className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                <Upload className="w-4 h-4" />
                <span>استعادة من ملف JSON</span>
                <input
                  type="file"
                  accept=".json"
                  disabled={!restorePassword}
                  onChange={handleRestoreBackupFile}
                  className="hidden"
                />
              </label>
            </div>
          </div>}

          {isRepresentative && user.isDemo && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
              <div className="flex items-center gap-2 text-base font-bold text-slate-900 dark:text-slate-100">
                <Shield className="w-5 h-5 text-amber-600" />
                <h2>إدارة البيانات التجريبية (Demo Seed Environment)</h2>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                البيانات التجريبية معزولة بعلامة <code>is_demo = 1</code>. يمكنك إعادة تهيئتها لحالتها القياسية أو إزالتها بالكامل دون المساس بأي بيانات حقيقية أضفتها.
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={async () => {
                    await apiFetch('/api/admin/demo-reset', { method: 'POST' });
                    notify('تمت إعادة تهيئة البيانات التجريبية إلى حالتها الأصلية');
                    await onRefresh();
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>إعادة تهيئة البيانات التجريبية</span>
                </button>

                {!confirmDemoPurge ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDemoPurge(true)}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف البيانات التجريبية فقط</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch('/api/admin/demo-purge', { method: 'POST' });
                      setConfirmDemoPurge(false);
                      notify('تم حذف البيانات التجريبية بنجاح');
                      await onRefresh();
                    }}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg bg-rose-600 text-white"
                  >
                    <span>تأكيد الحذف النهائي للبيانات التجريبية</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Audit Logs Table */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              سجل التدقيق والعمليات الإدارية (Audit Log)
            </h2>
            <span className="text-xs text-slate-500 font-mono tabular-nums">
              آخر {auditLogs.length} عملية موثقة
            </span>
          </div>

          <div className="space-y-3 lg:hidden p-3">{auditLogsLoading ? (Array.from({ length: 3 }).map((_, idx) => (<div key={idx} className="aurora-card p-4 space-y-2.5"><div className="flex items-center justify-between gap-2"><div className="h-3.5 w-28 rounded aurora-skeleton-shimmer" /><div className="h-5 w-16 rounded-full aurora-skeleton-shimmer" /></div><div className="h-3.5 w-40 rounded aurora-skeleton-shimmer" /><div className="h-3 w-full rounded aurora-skeleton-shimmer" /></div>))) : auditLogs.length === 0 ? (<div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">لا توجد سجلات مراجعة بعد.</div>) : (auditLogs.map((log) => (<div key={log.id} className="aurora-card aurora-stagger-item p-4 space-y-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-semibold text-slate-900 dark:text-slate-100 aurora-wrap">{log.actorName}</span><span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 text-[11px] font-medium whitespace-nowrap">{ROLE_LABELS_AR[log.actorRole] || log.actorRole}</span></div><div className="flex flex-wrap items-center justify-between gap-2 text-[11px]"><span className="font-mono text-teal-700 dark:text-teal-400 whitespace-nowrap">{log.action}</span><span className="aurora-ltr-token font-mono tabular-nums text-slate-500 whitespace-nowrap">{log.createdAt.slice(0, 19).replace('T', ' ')}</span></div>{log.details && (<p className="text-slate-700 dark:text-slate-300 aurora-wrap leading-relaxed">{log.details}</p>)}</div>)))}</div><div className="hidden lg:block overflow-x-auto">
            <table className="w-full min-w-[720px] text-xs text-right">
              <thead className="bg-slate-50 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
                <tr>
                  <th className="px-4 py-2.5 whitespace-nowrap">التوقيت</th>
                  <th className="px-4 py-2.5 whitespace-nowrap">المنفذ</th>
                  <th className="px-4 py-2.5 whitespace-nowrap">الدور</th>
                  <th className="px-4 py-2.5 whitespace-nowrap">العملية</th>
                  <th className="px-4 py-2.5 whitespace-nowrap">التفاصيل</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {auditLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-2.5 font-mono tabular-nums text-slate-500 whitespace-nowrap aurora-ltr-token">
                      {log.createdAt.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-4 py-2.5 font-semibold text-slate-900 dark:text-slate-100">
                      {log.actorName}
                    </td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-400">
                      {ROLE_LABELS_AR[log.actorRole] || log.actorRole}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-teal-700 dark:text-teal-400">
                      {log.action}
                    </td>
                    <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">
                      {log.details}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Students & Cohort Roster View
  const filteredMembers = members.filter((m) => {
    if (groupFilter !== 'ALL' && m.groupName !== groupFilter) return false;
    if (roleFilter !== 'ALL' && m.role !== roleFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      return (
        m.fullName.toLowerCase().includes(q) ||
        m.universityId.toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {newCredential && <aside role="status" className="rounded-lg border p-3">
        <p>رمز الدخول الأولي. سلّمه لصاحب الحساب على انفراد.</p>
        <code dir="ltr">{newCredential}</code>
        <button type="button" className="mx-3" onClick={() => setNewCredential('')}>إخفاء الرمز</button>
      </aside>}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            إدارة الطلاب والمجموعات وتفويض الصلاحيات
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            إدارة حسابات أعضاء الدفعة، المجموعات الدراسية (A / B)، وتحديد صلاحيات النائب والمنسقين بدقة.
          </p>
        </div>

        {canManageStudents && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleExportCsv}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Download className="w-3.5 h-3.5" />
              <span>تصدير CSV</span>
            </button>

            <button
              type="button"
              onClick={() => setShowCsvModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-teal-600 text-teal-700 dark:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/30"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" />
              <span>استيراد من CSV</span>
            </button>

            <button
              type="button"
              onClick={() => setShowAddUserModal(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700"
            >
              <Plus className="w-4 h-4" />
              <span>إضافة طالب / منسق</span>
            </button>
          </div>
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
            placeholder="بحث بالاسم أو الرقم الجامعي أو البريد..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 pr-9 pl-3 py-2 text-xs"
          />
        </div>

        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          aria-label="تصفية الطلاب حسب المجموعة"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="ALL">جميع المجموعات (A & B)</option>
          <option value="A">المجموعة A</option>
          <option value="B">المجموعة B</option>
        </select>

        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          aria-label="تصفية حسب الدور"
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs"
        >
          <option value="ALL">جميع الأدوار</option>
          <option value="representative">مندوب الدفعة</option>
          <option value="deputy">نائب المندوب</option>
          <option value="coordinator">منسق أكاديمي</option>
          <option value="student">طالب</option>
        </select>
      </div>

      {/* Roster Table */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="space-y-3 lg:hidden p-3">{filteredMembers.length === 0 ? (<div className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">لا توجد نتائج مطابقة.</div>) : (filteredMembers.map((m) => (<div key={m.id} className="aurora-card aurora-stagger-item p-4 space-y-3 text-xs"><div className="flex items-start justify-between gap-2"><div className="min-w-0 space-y-1"><div className="font-bold text-sm text-slate-900 dark:text-slate-100 aurora-wrap">{m.fullName}</div><div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono aurora-email">{m.email}</div></div><div className="flex flex-col items-end gap-1 shrink-0"><span className="px-2 py-0.5 rounded-full bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300 text-[11px] font-semibold whitespace-nowrap">{ROLE_LABELS_AR[m.role]}</span><span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${m.isActive ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-950/40 text-rose-600'}`}>{m.isActive ? 'نشط' : 'معطل'}</span></div></div><div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600 dark:text-slate-300"><span className="aurora-ltr-token font-mono tabular-nums font-semibold">{m.universityId}</span><span className="font-semibold whitespace-nowrap">مجموعة {m.groupName}</span></div><div className="flex flex-wrap gap-1.5">{m.role === 'representative' ? (<span className="px-2 py-0.5 rounded-full bg-teal-50 dark:bg-teal-950/50 text-teal-700 dark:text-teal-300 text-[11px] font-medium whitespace-nowrap">صلاحية شاملة لجميع الأقسام</span>) : m.responsibilities.length > 0 ? (m.responsibilities.map((r) => (<span key={r} className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-[11px] font-medium whitespace-nowrap">{RESPONSIBILITY_LABELS_AR[r] || r}</span>))) : (<span className="px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[11px] whitespace-nowrap">صلاحيات طالب اعتيادي</span>)}</div>{canManageStudents && (<button type="button" disabled={!isRepresentative && m.role !== 'student'} onClick={() => { setIssueNewPassword(false); setEditingMember({ ...m }); }} className="w-full min-h-[40px] aurora-btn-motion inline-flex items-center justify-center gap-1.5 rounded-lg border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-950/40 px-3 py-2 text-xs font-semibold text-teal-700 dark:text-teal-300 disabled:opacity-40"><Edit3 className="w-3.5 h-3.5" /><span>تعديل / صلاحيات</span></button>)}</div>)))}</div><div className="hidden lg:block overflow-x-auto">
          <table className="w-full min-w-[780px] text-xs text-right">
            <thead className="bg-slate-50 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="px-4 py-3 whitespace-nowrap">الرقم الجامعي</th>
                <th className="px-4 py-3 whitespace-nowrap">الاسم الكامل</th>
                <th className="px-4 py-3 whitespace-nowrap">المجموعة</th>
                <th className="px-4 py-3 whitespace-nowrap">الدور</th>
                <th className="px-4 py-3 whitespace-nowrap">المسؤوليات المفوضة</th>
                <th className="px-4 py-3 whitespace-nowrap">الحالة</th>
                {canManageStudents && <th className="px-4 py-3 whitespace-nowrap">إجراءات</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredMembers.map((m) => (
                <tr key={m.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-3 font-mono tabular-nums font-semibold whitespace-nowrap aurora-ltr-token">
                    {m.universityId}
                  </td>
                  <td className="px-4 py-3 font-bold text-slate-900 dark:text-slate-100">
                    {m.fullName}
                    <div className="text-[11px] font-normal text-slate-500 dark:text-slate-400 font-mono aurora-email">
                      {m.email}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-semibold">مجموعة {m.groupName}</td>
                  <td className="px-4 py-3 font-semibold text-teal-700 dark:text-teal-400">
                    {ROLE_LABELS_AR[m.role]}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-400 max-w-xs">
                    {m.role === 'representative'
                      ? 'صلاحيات كاملة لإدارة الدفعة'
                      : m.responsibilities.length > 0
                      ? m.responsibilities
                          .map((r) => RESPONSIBILITY_LABELS_AR[r] || r)
                          .join(' · ')
                      : 'صلاحيات الطالب الأساسية'}
                  </td>
                  <td className="px-4 py-3">
                    {m.isActive ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-semibold">
                        <UserCheck className="w-3.5 h-3.5" />
                        نشط
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-rose-600 font-semibold">
                        <UserX className="w-3.5 h-3.5" />
                        معطل
                      </span>
                    )}
                  </td>
                  {canManageStudents && (
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        disabled={!isRepresentative && m.role !== 'student'}
                        onClick={() => { setIssueNewPassword(false); setEditingMember({ ...m }); }}
                        className="inline-flex items-center gap-1 text-teal-700 dark:text-teal-400 font-semibold hover:underline"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        <span>تعديل / صلاحيات</span>
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add User Modal */}
      {showAddUserModal && (
        <div
          className="aurora-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="add-member-title"
        >
          <div className="aurora-modal-panel w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="add-member-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              إضافة عضو جديد إلى الدفعة
            </h3>
            <form onSubmit={handleAddMember} className="mt-4 space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">الرقم الجامعي</label>
                  <input
                    type="text"
                    value={universityId}
                    onChange={(e) => setUniversityId(e.target.value)}
                    required
                    placeholder="20251099"
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">المجموعة الدراسية</label>
                  <select
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="A">المجموعة A</option>
                    <option value="B">المجموعة B</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">الاسم الكامل</label>
                <input
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">البريد الإلكتروني</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">كلمة المرور الأولية</label>
                  <input
                    type="text"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 font-mono"
                  />
                </div>
              </div>

              {isRepresentative && (
                <>
                  <div>
                    <label className="block font-semibold mb-1">الدور في الدفعة</label>
                    <select
                      value={role}
                      onChange={(e) => setRole(e.target.value as UserRole)}
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                    >
                      <option value="student">طالب</option>
                      <option value="coordinator">منسق أكاديمي (بمسؤوليات محددة)</option>
                      <option value="deputy">نائب المندوب (بصلاحيات مفوضة)</option>
                    </select>
                  </div>

                  {(role === 'coordinator' || role === 'deputy') && (
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                      <p className="font-bold text-slate-800 dark:text-slate-200">
                        حدد الصلاحيات والمسؤوليات المفوضة لهذا الحساب:
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        {ALL_RESPONSIBILITY_KEYS.map((key) => (
                          <label key={key} className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={responsibilities.includes(key)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setResponsibilities([...responsibilities, key]);
                                } else {
                                  setResponsibilities(responsibilities.filter((k) => k !== key));
                                }
                              }}
                            />
                            <span>{RESPONSIBILITY_LABELS_AR[key]}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddUserModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  إنشاء الحساب
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Member & Permissions Modal */}
      {editingMember && (
        <div
          className="aurora-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-member-title"
        >
          <div className="aurora-modal-panel w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="edit-member-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              تعديل بيانات وصلاحيات: {editingMember.fullName}
            </h3>
            <form onSubmit={handleUpdateMember} className="mt-4 space-y-3 text-xs">
              {isRepresentative && editingMember.id !== user.id && <label className="flex items-center gap-2">
                <input type="checkbox" checked={issueNewPassword} onChange={event => setIssueNewPassword(event.target.checked)} />
                إصدار رمز دخول فردي وإغلاق جلسات العضو
              </label>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">الاسم الكامل</label>
                  <input
                    type="text"
                    value={editingMember.fullName}
                    onChange={(e) =>
                      setEditingMember({ ...editingMember, fullName: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">المجموعة</label>
                  <select
                    value={editingMember.groupName}
                    onChange={(e) =>
                      setEditingMember({ ...editingMember, groupName: e.target.value })
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="A">المجموعة A</option>
                    <option value="B">المجموعة B</option>
                  </select>
                </div>
              </div>

              {isRepresentative && (
                <>
                  <div>
                    <label className="block font-semibold mb-1">الدور</label>
                    <select
                      value={editingMember.role}
                      onChange={(e) =>
                        setEditingMember({
                          ...editingMember,
                          role: e.target.value as UserRole,
                        })
                      }
                      className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                    >
                      <option value="student">طالب</option>
                      <option value="coordinator">منسق أكاديمي</option>
                      <option value="deputy">نائب المندوب</option>
                      <option value="representative">مندوب الدفعة</option>
                    </select>
                  </div>

                  {(editingMember.role === 'deputy' ||
                    editingMember.role === 'coordinator') && (
                    <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-2">
                      <p className="font-bold">الصلاحيات المفوضة (قابلة للتخصيص دون منح الصلاحيات الحساسة تلقائياً):</p>
                      <div className="grid grid-cols-2 gap-2">
                        {ALL_RESPONSIBILITY_KEYS.map((key) => (
                          <label key={key} className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={editingMember.responsibilities.includes(key)}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? [...editingMember.responsibilities, key]
                                  : editingMember.responsibilities.filter((k) => k !== key);
                                setEditingMember({
                                  ...editingMember,
                                  responsibilities: next,
                                });
                              }}
                            />
                            <span>{RESPONSIBILITY_LABELS_AR[key]}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              <label className="flex items-center gap-2 font-semibold">
                <input
                  type="checkbox"
                  checked={editingMember.isActive}
                  onChange={(e) =>
                    setEditingMember({ ...editingMember, isActive: e.target.checked })
                  }
                />
                <span>الحساب مفعّل ومسموح له بتسجيل الدخول</span>
              </label>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingMember(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  حفظ التغييرات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CSV Import Modal */}
      {showCsvModal && (
        <div
          className="aurora-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="csv-modal-title"
        >
          <div className="aurora-modal-panel w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="csv-modal-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              استيراد قائمة الطلاب من ملف CSV
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              الصيغة لكل سطر: <code>الرقم_الجامعي,الاسم_الكامل,البريد_الإلكتروني,المجموعة</code>
            </p>
            <form onSubmit={handleImportCsv} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">بيانات CSV</label>
                <textarea
                  rows={5}
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  required
                  dir="ltr"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 p-3 font-mono text-xs"
                />
              </div>
              <p>ينزّل التطبيق ملف رموز فردية مرة واحدة. سلّم كل طالب رمزه على انفراد واحذف الملف بعد التوزيع.</p>
              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCsvModal(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  تنفيذ الاستيراد
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
