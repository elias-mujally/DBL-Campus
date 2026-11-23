import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Printer, Users, PenTool, X } from 'lucide-react';
import type { CohortRequest } from '../types';
import { REQUEST_STATUS_LABELS_AR } from '../utils/domainLogic';

interface OfficialDocumentModalProps {
  request: CohortRequest;
  cohortName?: string;
  representativeName: string;
  onClose: () => void;
}

export const OfficialDocumentModal: React.FC<OfficialDocumentModalProps> = ({
  request,
  cohortName = 'الدفعة الجامعية',
  representativeName,
  onClose,
}) => {
  const [docMode, setDocMode] = useState<'all' | 'petition' | 'endorsements' | 'manual_sheet'>('all');
  const [manualRowsCount, setManualRowsCount] = useState<number>(15);

  const typeLabelAr =
    request.requestType === 'request'
      ? 'طلب أكاديمي / إداري جماعي'
      : request.requestType === 'complaint'
      ? 'مذكرة شكوى طلابية'
      : 'مذكرة اقتراح تطويري';

  const endorsements = request.endorsements || [];
  const manualBlankRows = Array.from({ length: manualRowsCount }, (_, i) => i + 1);

  return createPortal(
    <div
      className="official-document-print fixed inset-0 z-50 overflow-y-auto bg-slate-950/75 p-4 md:p-8"
      role="dialog"
      aria-modal="true"
      aria-labelledby="official-doc-modal-title"
    >
      {/* Toolbar (hidden on print) */}
      <div className="no-print mx-auto max-w-4xl mb-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-4 shadow-lg flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 id="official-doc-modal-title" className="text-base font-bold text-slate-900 dark:text-slate-100">
            تصدير وطباعة المستندات الرسمية (مقاس A4 — RTL)
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            الرقم المرجعي: <span className="font-mono tabular-nums">{request.referenceNumber}</span> · يميز النظام بصرامة بين التأييد الإلكتروني والتوقيع اليدوي الحي.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg">
            <button
              type="button"
              onClick={() => setDocMode('all')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                docMode === 'all'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              الحزمة الكاملة (3 مستندات)
            </button>
            <button
              type="button"
              onClick={() => setDocMode('petition')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1 ${
                docMode === 'petition'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>1. نموذج الطلب الرسمي</span>
            </button>
            <button
              type="button"
              onClick={() => setDocMode('endorsements')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1 ${
                docMode === 'endorsements'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>2. كشف التأييد الإلكتروني</span>
            </button>
            <button
              type="button"
              onClick={() => setDocMode('manual_sheet')}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap inline-flex items-center gap-1 ${
                docMode === 'manual_sheet'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <PenTool className="w-3.5 h-3.5" />
              <span>3. صفحات التوقيعات اليدوية</span>
            </button>
          </div>

          {docMode === 'manual_sheet' || docMode === 'all' ? (
            <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
              <span>صفوف التوقيع:</span>
              <select
                value={manualRowsCount}
                onChange={(e) => setManualRowsCount(Number(e.target.value))}
                className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 py-1 text-xs tabular-nums"
              >
                <option value={10}>10 صفوف</option>
                <option value={15}>15 صفاً</option>
                <option value={25}>25 صفاً</option>
              </select>
            </label>
          ) : null}

          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors whitespace-nowrap"
          >
            <Printer className="w-4 h-4" />
            <span>طباعة / حفظ PDF (A4)</span>
          </button>

          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق معاينة المستندات"
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Document 1: Official Petition Form */}
      {(docMode === 'all' || docMode === 'petition') && (
        <div className="print-page-a4 mx-auto max-w-4xl bg-white text-slate-950 p-8 md:p-12 rounded-xl shadow-xl mb-6 border border-slate-200">
          {/* Header Banner */}
          <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
            <div className="space-y-1 text-xs font-semibold">
              <p>الجمهورية اليمنية — التعليم العالي</p>
              <p>مندوبية الدفعة الجامعية — {cohortName}</p>
            </div>
            <div className="text-center">
              <p className="text-sm font-bold">بسم الله الرحمن الرحيم</p>
              <p className="text-xs text-slate-600 mt-1">نموذج معاملة طلابية رسمية</p>
            </div>
            <div className="space-y-1 text-xs text-left">
              <p>
                الرقم المرجعي:{' '}
                <span className="font-mono tabular-nums font-semibold">{request.referenceNumber}</span>
              </p>
              <p>
                التاريخ:{' '}
                <span className="font-mono tabular-nums">{request.createdAt.slice(0, 10)}</span>
              </p>
              <p>
                نسخة النص:{' '}
                <span className="font-mono tabular-nums">{request.versionHash}</span>
              </p>
            </div>
          </div>

          {/* Addressee & Subject */}
          <div className="mt-8 space-y-4">
            <div className="flex items-center justify-between text-base font-bold">
              <p>
                {request.targetAuthority.startsWith('الأخ')
                  ? request.targetAuthority.replace(/\s*المحترم\s*$/, '')
                  : `الأخ / ${request.targetAuthority.replace(/\s*المحترم\s*$/, '')}`}
              </p>
              <span className="font-normal">المحترم</span>
            </div>
            <p className="text-sm text-slate-700">تحية طيبة وبعد،،،</p>

            <div className="p-3.5 bg-slate-50 border border-slate-300 rounded-lg">
              <p className="text-xs text-slate-500">نوع المعاملة: {typeLabelAr}</p>
              <h3 className="text-base font-bold text-slate-950 mt-1">
                الموضوع: {request.subject}
              </h3>
            </div>
          </div>

          {/* Details & Proposed Solution */}
          <div className="mt-6 space-y-5 text-sm leading-relaxed">
            <div>
              <h4 className="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-2">
                أولاً: شرح وتفاصيل الموضوع / المشكلة:
              </h4>
              <p className="text-slate-800 whitespace-pre-line">{request.details}</p>
            </div>

            {request.proposedSolution && (
              <div>
                <h4 className="font-bold text-slate-900 border-b border-slate-300 pb-1 mb-2">
                  ثانياً: المقترح والحل المطلوب:
                </h4>
                <p className="text-slate-800 whitespace-pre-line">{request.proposedSolution}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 pt-2 text-xs bg-slate-50 p-3.5 rounded-lg border border-slate-200">
              <div>
                <span className="text-slate-500">الحالة الإجرائية للمعاملة: </span>
                <strong className="text-slate-900">{REQUEST_STATUS_LABELS_AR[request.status]}</strong>
              </div>
              <div>
                <span className="text-slate-500">إجمالي التأييدات الإلكترونية المسجلة: </span>
                <strong className="text-slate-900">
                  <span className="font-mono tabular-nums">{request.endorsementCount}</span> طالب/طالبة
                </strong>
              </div>
            </div>

            {request.authorityResponse && (
              <div className="p-4 border-2 border-slate-800 rounded-lg bg-slate-50">
                <h4 className="font-bold text-slate-900 mb-1">
                  توجيه / رد الجهة المختصة الموثق:
                </h4>
                <p className="text-slate-900">{request.authorityResponse}</p>
              </div>
            )}
          </div>

          {/* Signatures Footer */}
          <div className="mt-12 pt-6 border-t border-slate-300 grid grid-cols-3 gap-6 text-xs text-center">
            <div className="space-y-8">
              <p className="font-bold">مقدم المعاملة / المتابع</p>
              <p className="text-slate-700">{request.creatorName || representativeName}</p>
              <div className="border-b border-dashed border-slate-400 w-36 mx-auto pt-4" />
              <p className="text-[11px] text-slate-500">التوقيع اليدوي الحي</p>
            </div>

            <div className="space-y-8">
              <p className="font-bold">مندوب الدفعة</p>
              <p className="text-slate-700">{representativeName}</p>
              <div className="border-b border-dashed border-slate-400 w-36 mx-auto pt-4" />
              <p className="text-[11px] text-slate-500">التوقيع اليدوي والتاريخ</p>
            </div>

            <div className="space-y-8">
              <p className="font-bold">اعتماد وتوجيه الجهة المختصة</p>
              <p className="text-slate-700">........................................</p>
              <div className="border-b border-dashed border-slate-400 w-36 mx-auto pt-4" />
              <p className="text-[11px] text-slate-500">الختم والتوقيع الرسمي</p>
            </div>
          </div>

          <div className="mt-8 pt-3 border-t border-slate-200 text-[11px] text-slate-500 flex items-center justify-between">
            <span>صادر عبر منصة DBL Campus لإدارة الدفعات الجامعية</span>
            <span>ملاحظة: التأييد الإلكتروني المرفق لا يُعد توقيعاً قانونياً بخط اليد ما لم يُوقّع يدوياً</span>
          </div>
        </div>
      )}

      {/* Document 2: Student Electronic Endorsement Roster */}
      {(docMode === 'all' || docMode === 'endorsements') && (
        <div className="print-page-a4 mx-auto max-w-4xl bg-white text-slate-950 p-8 md:p-12 rounded-xl shadow-xl mb-6 border border-slate-200">
          <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
            <div>
              <h3 className="text-base font-bold">
                كشف تأييد الطلاب المسجلين إلكترونياً للمعاملة رقم ({request.referenceNumber})
              </h3>
              <p className="text-xs text-slate-600 mt-1">
                الموضوع: {request.subject}
              </p>
            </div>
            <div className="text-xs font-mono tabular-nums text-left">
              <p>عدد المؤيدين: {request.endorsementCount}</p>
              <p>بصمة النص: {request.versionHash}</p>
            </div>
          </div>

          <div className="mt-4 p-3 bg-amber-50 border border-amber-300 rounded-lg text-xs text-amber-950">
            <strong>تنبيه توثيقي:</strong> يوضح هذا الكشف الطلاب الذين سجلوا تأييدهم الإلكتروني من حساباتهم الموثقة في منصة الدفعة على نسخة النص ({request.versionHash}). عمود &quot;التوقيع اليدوي&quot; يُترك فارغاً تماماً ولا يُطبع فيه أي توقيع آلي، ليوقعه الطالب بخط يده عند اشتراط الإدارة ذلك.
          </div>

          <table className="w-full mt-5 border-collapse border border-slate-400 text-xs">
            <thead>
              <tr className="bg-slate-100 text-slate-900">
                <th className="border border-slate-400 px-2.5 py-2 text-right w-10">#</th>
                <th className="border border-slate-400 px-3 py-2 text-right">الاسم الكامل للطالب</th>
                <th className="border border-slate-400 px-3 py-2 text-right w-28">الرقم الجامعي</th>
                <th className="border border-slate-400 px-2.5 py-2 text-center w-20">المجموعة</th>
                <th className="border border-slate-400 px-3 py-2 text-right w-48">حالة التأييد الإلكتروني</th>
                <th className="border border-slate-400 px-3 py-2 text-center w-36">التوقيع اليدوي (عند الطلب)</th>
              </tr>
            </thead>
            <tbody>
              {endorsements.length === 0 ? (
                <tr>
                  <td colSpan={6} className="border border-slate-400 px-4 py-6 text-center text-slate-500">
                    لا توجد تأييدات إلكترونية مسجلة حتى الآن أو أن حسابك لا يملك صلاحية استعراض أسماء المؤيدين.
                  </td>
                </tr>
              ) : (
                endorsements.map((end, index) => (
                  <tr key={end.id}>
                    <td className="border border-slate-400 px-2.5 py-2 font-mono tabular-nums">{index + 1}</td>
                    <td className="border border-slate-400 px-3 py-2 font-medium">
                      {(end.studentName || '').replace(' - تجريبي)', ')')}
                    </td>
                    <td className="border border-slate-400 px-3 py-2 font-mono tabular-nums">
                      {end.universityId || '—'}
                    </td>
                    <td className="border border-slate-400 px-2.5 py-2 text-center">
                      {end.groupName || 'A'}
                    </td>
                    <td className="border border-slate-400 px-3 py-2 text-[11px] text-slate-700">
                      مؤيد إلكترونياً ({end.createdAt.slice(0, 10)}) · {end.requestVersionHash}
                    </td>
                    <td className="border border-slate-400 px-3 py-3">
                      {/* Intentionally blank for wet-ink signature */}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Document 3: Supplementary Manual Signature Pages */}
      {(docMode === 'all' || docMode === 'manual_sheet') && (
        <div className="print-page-a4 mx-auto max-w-4xl bg-white text-slate-950 p-8 md:p-12 rounded-xl shadow-xl mb-6 border border-slate-200">
          <div className="flex items-start justify-between border-b-2 border-slate-900 pb-4">
            <div>
              <h3 className="text-base font-bold">
                ملحق تكميلي للتوقيعات اليدوية الحية — المعاملة رقم ({request.referenceNumber})
              </h3>
              <p className="text-xs text-slate-600 mt-1">
                الموضوع: {request.subject} · الدفعة: {cohortName}
              </p>
            </div>
            <div className="text-xs font-mono tabular-nums text-left">
              <p>التاريخ: {new Date().toISOString().slice(0, 10)}</p>
              <p>نسخة النص: {request.versionHash}</p>
            </div>
          </div>

          <p className="mt-4 text-xs text-slate-700">
            يُخصص هذا الكشف التكميلي لجمع التوقيعات اليدوية الحية للطلاب المؤيدين لمضمون المعاملة أعلاه والذين لم يتمكنوا من الدخول إلى المنصة أو لاشتراط الجهة المختصة إرفاق توقيعات ورقية حية:
          </p>

          <table className="w-full mt-4 border-collapse border border-slate-400 text-xs">
            <thead>
              <tr className="bg-slate-100 text-slate-900">
                <th className="border border-slate-400 px-2.5 py-2 text-right w-10">م</th>
                <th className="border border-slate-400 px-3 py-2 text-right">اسم الطالب رباعياً (بخط اليد)</th>
                <th className="border border-slate-400 px-3 py-2 text-right w-32">الرقم الجامعي</th>
                <th className="border border-slate-400 px-2.5 py-2 text-center w-20">المجموعة</th>
                <th className="border border-slate-400 px-3 py-2 text-center w-44">التوقيع اليدوي الحي</th>
                <th className="border border-slate-400 px-3 py-2 text-center w-28">ملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {manualBlankRows.map((num) => (
                <tr key={num}>
                  <td className="border border-slate-400 px-2.5 py-3 font-mono tabular-nums text-slate-600">
                    {num}
                  </td>
                  <td className="border border-slate-400 px-3 py-3" />
                  <td className="border border-slate-400 px-3 py-3" />
                  <td className="border border-slate-400 px-2.5 py-3" />
                  <td className="border border-slate-400 px-3 py-3" />
                  <td className="border border-slate-400 px-3 py-3" />
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-8 pt-4 border-t border-slate-300 flex items-center justify-between text-xs">
            <span>إقرار مندوب الدفعة بصحة جمع التوقيعات: {representativeName}</span>
            <span>التوقيع: ........................................</span>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
