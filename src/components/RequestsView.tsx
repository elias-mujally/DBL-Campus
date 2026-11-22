import React, { useState } from 'react';
import {
  CheckCircle,
  Edit3,
  FileSpreadsheet,
  History,
  Plus,
  ThumbsUp,
  Undo2,
  ShieldAlert,
} from 'lucide-react';
import type { CohortRequest, RequestStatus, RequestType, UserAccount } from '../types';
import { REQUEST_STATUS_LABELS_AR, hasPermission } from '../utils/domainLogic';
import { apiFetch } from '../utils/api';
import { OfficialDocumentModal } from './OfficialDocumentModal';

interface RequestsViewProps {
  user: UserAccount;
  requests: CohortRequest[];
  onRefresh: () => Promise<void>;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

const TYPE_LABELS: Record<RequestType, string> = {
  request: 'طلب أكاديمي / إداري',
  complaint: 'شكوى طلابية',
  suggestion: 'اقتراح تطويري',
};

export const RequestsView: React.FC<RequestsViewProps> = ({
  user,
  requests,
  onRefresh,
  notify,
}) => {
  const canManage = hasPermission(user, 'requests');
  const [filterType, setFilterType] = useState<'ALL' | RequestType>('ALL');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedDocRequest, setSelectedDocRequest] = useState<CohortRequest | null>(null);
  const [managingRequest, setManagingRequest] = useState<CohortRequest | null>(null);
  const [editingRequest, setEditingRequest] = useState<CohortRequest | null>(null);
  const [expandedHistoryId, setExpandedHistoryId] = useState<string | null>(null);

  // Create form state
  const [requestType, setRequestType] = useState<RequestType>('request');
  const [isCollective, setIsCollective] = useState(true);
  const [targetAuthority, setTargetAuthority] = useState(
    'الأخ/ رئيس قسم تقنية المعلومات وعلوم الحاسوب المحترم'
  );
  const [subject, setSubject] = useState('');
  const [details, setDetails] = useState('');
  const [proposedSolution, setProposedSolution] = useState('');
  const [initialStatus, setInitialStatus] = useState<'open_for_endorsement' | 'draft'>(
    'open_for_endorsement'
  );

  // Admin status update form state
  const [nextStatus, setNextStatus] = useState<RequestStatus>('ready_for_submission');
  const [authorityResponse, setAuthorityResponse] = useState('');
  const [statusNote, setStatusNote] = useState('');

  // Edit text state
  const [editAuthority, setEditAuthority] = useState('');
  const [editSubject, setEditSubject] = useState('');
  const [editDetails, setEditDetails] = useState('');
  const [editSolution, setEditSolution] = useState('');
  const [needsResetConfirm, setNeedsResetConfirm] = useState(false);

  const handleCreateRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/requests', {
        method: 'POST',
        body: JSON.stringify({
          requestType,
          isCollective,
          targetAuthority,
          subject,
          details,
          proposedSolution,
          initialStatus,
        }),
      });
      notify('تم إنشاء المعاملة وتسجيلها برقم مرجعي فريد');
      setSubject('');
      setDetails('');
      setProposedSolution('');
      setShowCreateModal(false);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر إنشاء المعاملة', 'error');
    }
  };

  const handleEndorse = async (reqId: string) => {
    try {
      await apiFetch(`/api/requests/${reqId}/endorse`, { method: 'POST' });
      notify('تم تسجيل تأييدك الإلكتروني للطلب الجماعي');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر تسجيل التأييد', 'error');
    }
  };

  const handleWithdrawEndorsement = async (reqId: string) => {
    try {
      await apiFetch(`/api/requests/${reqId}/endorse`, { method: 'DELETE' });
      notify('تم سحب تأييدك من الطلب');
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر سحب التأييد', 'error');
    }
  };

  const handleStatusTransition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managingRequest) return;
    try {
      await apiFetch(`/api/requests/${managingRequest.id}/status`, {
        method: 'PUT',
        body: JSON.stringify({
          nextStatus,
          authorityResponse: authorityResponse.trim() || undefined,
          note: statusNote.trim() || undefined,
        }),
      });
      notify('تم تحديث حالة المعاملة وتوثيق الانتقال في السجل');
      setManagingRequest(null);
      await onRefresh();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'انتقال حالة غير مسموح', 'error');
    }
  };

  const handleSaveEditText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRequest) return;
    try {
      const res = await apiFetch<{ ok: boolean; endorsementsReset?: boolean }>(
        `/api/requests/${editingRequest.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            targetAuthority: editAuthority,
            subject: editSubject,
            details: editDetails,
            proposedSolution: editSolution,
            confirmResetEndorsements: needsResetConfirm,
          }),
        }
      );
      if (res.endorsementsReset) {
        notify('تم تحديث نص الطلب وإعادة ضبط التأييدات السابقة لإعادة التأكيد على النص الجديد');
      } else {
        notify('تم تحديث بيانات الطلب بنجاح');
      }
      setEditingRequest(null);
      setNeedsResetConfirm(false);
      await onRefresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'تعذر التعديل';
      if (msg.includes('يتطلب إعادة تأكيد')) {
        setNeedsResetConfirm(true);
      } else {
        notify(msg, 'error');
      }
    }
  };

  const filtered = requests.filter((r) =>
    filterType === 'ALL' ? true : r.requestType === filterType
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            نظام الطلبات والشكاوى والاقتراحات وكشوف التأييد
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            متابعة المعاملات الطلابية من المسودة وجمع التأييد حتى الرفع الرسمي وقرار الجهة المختصة.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setFilterType('ALL')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                filterType === 'ALL'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              الكل ({requests.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterType('request')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                filterType === 'request'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              طلبات
            </button>
            <button
              type="button"
              onClick={() => setFilterType('complaint')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                filterType === 'complaint'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              شكاوى
            </button>
            <button
              type="button"
              onClick={() => setFilterType('suggestion')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                filterType === 'suggestion'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              اقتراحات
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>تقديم طلب / شكوى / اقتراح</span>
          </button>
        </div>
      </div>

      {/* Requests List */}
      <div className="space-y-4">
        {filtered.map((req) => {
          const canEditThis =
            (canManage || req.createdBy === user.id) &&
            ['draft', 'open_for_endorsement'].includes(req.status);

          return (
            <div
              key={req.id}
              className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5"
            >
              {/* Top Metadata Line (Zero-Pill clean unboxed metadata) */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono font-bold text-slate-800 dark:text-slate-200">
                    {req.referenceNumber}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-teal-700 dark:text-teal-400">
                    {TYPE_LABELS[req.requestType]}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{req.isCollective ? 'معاملة جماعية للدفعة' : 'معاملة فردية'}</span>
                  <span aria-hidden="true">·</span>
                  <span>تاريخ الإنشاء: {req.createdAt.slice(0, 10)}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-slate-500">الحالة:</span>
                  <strong
                    className={`font-bold ${
                      req.status === 'approved' || req.status === 'approved_with_modifications'
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : req.status === 'rejected'
                        ? 'text-rose-600 dark:text-rose-400'
                        : req.status === 'open_for_endorsement'
                        ? 'text-teal-700 dark:text-teal-400'
                        : 'text-amber-700 dark:text-amber-400'
                    }`}
                  >
                    {REQUEST_STATUS_LABELS_AR[req.status]}
                  </strong>
                </div>
              </div>

              <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                موجه إلى: <strong className="text-slate-700 dark:text-slate-300">{req.targetAuthority}</strong>
              </p>

              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mt-1">
                {req.subject}
              </h3>

              <p className="text-sm text-slate-700 dark:text-slate-300 mt-2 leading-relaxed">
                {req.details}
              </p>

              {req.proposedSolution && (
                <div className="mt-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-800 text-xs">
                  <strong className="text-slate-900 dark:text-slate-200">الحل المقترح: </strong>
                  <span className="text-slate-700 dark:text-slate-300">{req.proposedSolution}</span>
                </div>
              )}

              {req.authorityResponse && (
                <div className="mt-3 p-3.5 rounded-lg bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-300 dark:border-emerald-800 text-xs">
                  <strong className="text-emerald-950 dark:text-emerald-200 block mb-0.5">
                    رد وقرار الجهة المختصة الموثق:
                  </strong>
                  <span className="text-emerald-900 dark:text-emerald-300">
                    {req.authorityResponse}
                  </span>
                </div>
              )}

              {/* Endorsement & Action Bar */}
              <div className="mt-4 pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  {req.isCollective && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                        المؤيدون إلكترونياً: <strong className="font-mono text-sm text-teal-700 dark:text-teal-400">{req.endorsementCount}</strong> طالب/طالبة
                      </span>

                      {req.status === 'open_for_endorsement' && (
                        <>
                          {!req.userHasEndorsed ? (
                            <button
                              type="button"
                              onClick={() => handleEndorse(req.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors"
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                              <span>تأييد الطلب</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleWithdrawEndorsement(req.id)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors"
                            >
                              <Undo2 className="w-3.5 h-3.5" />
                              <span>سحب التأييد</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedHistoryId(expandedHistoryId === req.id ? null : req.id)
                    }
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                  >
                    <History className="w-3.5 h-3.5" />
                    <span>سجل الانتقالات ({req.history?.length || 0})</span>
                  </button>

                  {canEditThis && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingRequest(req);
                        setEditAuthority(req.targetAuthority);
                        setEditSubject(req.subject);
                        setEditDetails(req.details);
                        setEditSolution(req.proposedSolution);
                        setNeedsResetConfirm(false);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>تعديل النص</span>
                    </button>
                  )}

                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setManagingRequest(req);
                          setNextStatus(
                            req.status === 'open_for_endorsement'
                              ? 'ready_for_submission'
                              : req.status === 'ready_for_submission'
                              ? 'submitted'
                              : req.status === 'submitted'
                              ? 'under_review'
                              : 'approved'
                          );
                          setAuthorityResponse(req.authorityResponse || '');
                          setStatusNote('');
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-slate-700 text-white font-semibold hover:opacity-90"
                      >
                        <CheckCircle className="w-3.5 h-3.5" />
                        <span>تحديث الحالة / القرار</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setSelectedDocRequest(req)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-teal-600 text-teal-700 dark:text-teal-400 font-semibold hover:bg-teal-50 dark:hover:bg-teal-950/40"
                      >
                        <FileSpreadsheet className="w-3.5 h-3.5" />
                        <span>المستندات الرسمية وكشف التأييد (A4)</span>
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Audit & Transition History Drawer */}
              {expandedHistoryId === req.id && req.history && (
                <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 p-3.5 rounded-lg space-y-2 text-xs">
                  <h4 className="font-bold text-slate-800 dark:text-slate-200">
                    سجل التغييرات وانتقالات الحالة الموثق:
                  </h4>
                  {req.history.map((h) => (
                    <div
                      key={h.id}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/60 dark:border-slate-800 pb-1.5 last:border-none"
                    >
                      <div>
                        <strong className="text-slate-900 dark:text-slate-100">{h.action}</strong>{' '}
                        <span className="text-slate-500">بواسطة {h.actorName}</span>
                        {h.newStatus && (
                          <span className="text-teal-700 dark:text-teal-400 font-medium">
                            {' '}
                            ← {REQUEST_STATUS_LABELS_AR[h.newStatus as RequestStatus] || h.newStatus}
                          </span>
                        )}
                        <p className="text-slate-600 dark:text-slate-400 mt-0.5">{h.note}</p>
                      </div>
                      <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                        {h.createdAt.slice(0, 16).replace('T', ' ')}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create Request Modal */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-req-title"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="create-req-title" className="text-lg font-bold text-slate-900 dark:text-slate-100">
              إنشاء طلب أو شكوى أو اقتراح جديد
            </h3>
            <form onSubmit={handleCreateRequest} className="mt-4 space-y-3 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold mb-1">نوع المعاملة</label>
                  <select
                    value={requestType}
                    onChange={(e) => setRequestType(e.target.value as RequestType)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="request">طلب أكاديمي / إداري</option>
                    <option value="complaint">شكوى</option>
                    <option value="suggestion">اقتراح تطويري</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">نطاق المعاملة</label>
                  <select
                    value={isCollective ? 'collective' : 'individual'}
                    onChange={(e) => setIsCollective(e.target.value === 'collective')}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="collective">معاملة جماعية (متاحة لتأييد طلاب الدفعة)</option>
                    <option value="individual">معاملة فردية خاصة (تُرفع للمندوب مباشرة)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">الجهة الموجهة إليها المعاملة</label>
                <input
                  type="text"
                  value={targetAuthority}
                  onChange={(e) => setTargetAuthority(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">موضوع المعاملة</label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  required
                  placeholder="عنوان واضح ومختصر للطلب أو المشكلة..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">تفاصيل المشكلة / المبررات</label>
                <textarea
                  rows={3}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  required
                  placeholder="اشرح السياق الأكاديمي والتفاصيل بدقة..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">الحل المقترح</label>
                <textarea
                  rows={2}
                  value={proposedSolution}
                  onChange={(e) => setProposedSolution(e.target.value)}
                  placeholder="ما هو الإجراء أو الحل العملي المقترح؟"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              {isCollective && canManage && (
                <div>
                  <label className="block font-semibold mb-1">حالة الطرح الأولية</label>
                  <select
                    value={initialStatus}
                    onChange={(e) =>
                      setInitialStatus(e.target.value as 'open_for_endorsement' | 'draft')
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                  >
                    <option value="open_for_endorsement">طرح مباشرة لجمع تأييد الطلاب</option>
                    <option value="draft">حفظ كمسودة أولية قبل الطرح</option>
                  </select>
                </div>
              )}

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
                  حفظ المعاملة
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Manage Request Status Modal */}
      {managingRequest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="manage-status-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="manage-status-title" className="text-base font-bold text-slate-900 dark:text-slate-100">
              تحديث الحالة الإدارية للمعاملة ({managingRequest.referenceNumber})
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              الحالة الحالية: <strong>{REQUEST_STATUS_LABELS_AR[managingRequest.status]}</strong>.
              لا يُسمح باعتماد الطلب إدارياً قبل رفعه رسمياً للجهة المختصة.
            </p>
            <form onSubmit={handleStatusTransition} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">الانتقال إلى الحالة التالية</label>
                <select
                  value={nextStatus}
                  onChange={(e) => setNextStatus(e.target.value as RequestStatus)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                >
                  <option value="open_for_endorsement">مفتوح للتأييد</option>
                  <option value="ready_for_submission">جاهز للرفع (إغلاق باب التأييد)</option>
                  <option value="submitted">تم رفعه رسمياً للجهة المختصة</option>
                  <option value="under_review">قيد الدراسة لدى الجهة المختصة</option>
                  <option value="approved">تمت الموافقة الرسمية</option>
                  <option value="approved_with_modifications">مقبول بتعديل</option>
                  <option value="rejected">تعذر التنفيذ</option>
                  <option value="closed">مغلق</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold mb-1">
                  رد الجهة المختصة الرسمي (يظهر للطلاب وفي نموذج الطباعة)
                </label>
                <textarea
                  rows={3}
                  value={authorityResponse}
                  onChange={(e) => setAuthorityResponse(e.target.value)}
                  placeholder="أدخل نص التوجيه أو القرار الصادر من القسم / الكلية..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div>
                <label className="block font-semibold mb-1">ملاحظة لسجل العمليات</label>
                <input
                  type="text"
                  value={statusNote}
                  onChange={(e) => setStatusNote(e.target.value)}
                  placeholder="مثال: تم تسليم الملف ورقياً لسكرتارية القسم..."
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setManagingRequest(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  تأكيد وحفظ الانتقال
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Request Text Modal with Endorsement Protection Warning */}
      {editingRequest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-req-title"
        >
          <div className="w-full max-w-lg rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-6 shadow-xl">
            <h3 id="edit-req-title" className="text-base font-bold text-slate-900 dark:text-slate-100">
              تعديل نص المعاملة ({editingRequest.referenceNumber})
            </h3>
            {editingRequest.endorsementCount > 0 && (
              <div className="mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  تنبيه نزاهة التأييد: هذه المعاملة لديها ({editingRequest.endorsementCount}) تأييد
                  مسجل. أي تعديل جوهري في النص سيتطلب إعادة ضبط التأييدات السابقة ليؤكد الطلاب
                  موافقتهم على الصياغة الجديدة.
                </span>
              </div>
            )}

            <form onSubmit={handleSaveEditText} className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">الجهة الموجهة إليها</label>
                <input
                  type="text"
                  value={editAuthority}
                  onChange={(e) => setEditAuthority(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">الموضوع</label>
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">التفاصيل</label>
                <textarea
                  rows={3}
                  value={editDetails}
                  onChange={(e) => setEditDetails(e.target.value)}
                  required
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">الحل المقترح</label>
                <textarea
                  rows={2}
                  value={editSolution}
                  onChange={(e) => setEditSolution(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2"
                />
              </div>

              {needsResetConfirm && (
                <label className="flex items-center gap-2 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-200 font-semibold">
                  <input
                    type="checkbox"
                    checked={needsResetConfirm}
                    onChange={(e) => setNeedsResetConfirm(e.target.checked)}
                  />
                  <span>
                    أؤكد تعديل النص الجوهري وإعادة فتح جمع التأييدات من جديد على الصياغة المعدلة
                  </span>
                </label>
              )}

              <div className="pt-3 flex justify-end gap-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingRequest(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-semibold"
                >
                  حفظ التعديلات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Official Printable A4 Document Modal */}
      {selectedDocRequest && (
        <OfficialDocumentModal
          request={selectedDocRequest}
          representativeName={user.fullName.replace(' - تجريبي)', ')')}
          onClose={() => setSelectedDocRequest(null)}
        />
      )}
    </div>
  );
};
