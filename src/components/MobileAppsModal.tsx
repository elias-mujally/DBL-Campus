import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  GitBranch,
  Globe,
  Server,
  Smartphone,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { UserAccount } from '../types';
import { apiFetch, buildApiUrl, formatBytes, getAuthToken } from '../utils/api';
import {
  getSavedServerBaseUrl,
  isNativeCapacitorApp,
  saveServerBaseUrl,
  validateServerBaseUrl,
} from '../utils/mobileConfig';

interface MobileReleaseInfo {
  platform: 'apk' | 'ipa';
  fileName: string;
  available: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  sha256: string | null;
}

interface MobileReleasesPayload {
  apk: MobileReleaseInfo;
  ipa: MobileReleaseInfo;
  lanUrls: string[];
  workflowFile: string;
}

interface MobileAppsModalProps {
  user: UserAccount | null;
  onClose: () => void;
  notify: (msg: string, type?: 'success' | 'error') => void;
}

export const MobileAppsModal: React.FC<MobileAppsModalProps> = ({
  user,
  onClose,
  notify,
}) => {
  const isRepresentative = user?.role === 'representative';
  const [activeTab, setActiveTab] = useState<'download' | 'server'>(
    isNativeCapacitorApp() ? 'server' : 'download'
  );
  const [releases, setReleases] = useState<MobileReleasesPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<'apk' | 'ipa' | null>(null);

  // Native LAN Server connection state
  const [serverUrlInput, setServerUrlInput] = useState(getSavedServerBaseUrl());
  const [testingServer, setTestingServer] = useState(false);
  const [serverCheckStatus, setServerCheckStatus] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const loadReleases = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<MobileReleasesPayload>('/api/mobile/releases');
      setReleases(data);
    } catch {
      setReleases(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReleases();
  }, [loadReleases]);

  const handleUploadPackage = async (
    platform: 'apk' | 'ipa',
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const expectedExt = platform === 'apk' ? '.apk' : '.ipa';
    if (!file.name.toLowerCase().endsWith(expectedExt)) {
      notify(`يرجى اختيار ملف بامتداد ${expectedExt} فقط.`, 'error');
      e.target.value = '';
      return;
    }

    setUploading(platform);
    try {
      const arrayBuf = await file.arrayBuffer();
      const res = await fetch(buildApiUrl(`/api/mobile/releases/upload?platform=${platform}`), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${getAuthToken()}`,
        },
        body: arrayBuf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'تعذر رفع حزمة التطبيق.');
      }
      notify(`تم رفع حزمة ${platform.toUpperCase()} بنجاح وأصبحت جاهزة لتنزيل الطلاب`);
      await loadReleases();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر رفع الحزمة', 'error');
    } finally {
      setUploading(null);
      e.target.value = '';
    }
  };

  const handleDeletePackage = async (platform: 'apk' | 'ipa') => {
    try {
      await apiFetch(`/api/mobile/releases/${platform}`, { method: 'DELETE' });
      notify(`تم حذف حزمة ${platform.toUpperCase()} من الخادم`);
      await loadReleases();
    } catch (err: unknown) {
      notify(err instanceof Error ? err.message : 'تعذر الحذف', 'error');
    }
  };

  const handleCopyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`تم نسخ ${label}`);
    } catch {
      notify('تعذر النسخ التلقائي، يمكنك النسخ يدوياً', 'error');
    }
  };

  const handleTestAndSaveServer = async (e: React.FormEvent) => {
    e.preventDefault();
    const check = validateServerBaseUrl(serverUrlInput);
    if (!check.valid) {
      setServerCheckStatus({ ok: false, message: check.errorAr || 'عنوان غير صالح' });
      return;
    }

    setTestingServer(true);
    setServerCheckStatus(null);
    try {
      const targetUrl = check.normalized
        ? `${check.normalized}/api/auth/status`
        : '/api/auth/status';
      const res = await fetch(targetUrl);
      if (!res.ok) {
        throw new Error(`استجاب الخادم برمز خطأ (${res.status})`);
      }
      saveServerBaseUrl(check.normalized);
      setServerUrlInput(check.normalized);
      setServerCheckStatus({
        ok: true,
        message: check.normalized
          ? `تم الاتصال بالخادم (${check.normalized}) وحفظ الإعداد بنجاح.`
          : 'تمت إعادة الضبط للاتصال بالخادم المحلي الافتراضي.',
      });
      notify('تم حفظ عنوان خادم الشبكة المحلية بنجاح');
    } catch {
      setServerCheckStatus({
        ok: false,
        message:
          'تعذر الوصول إلى هذا الخادم. تأكد أن الهاتف متصل بنفس شبكة Wi-Fi وأن الخادم يعمل على المنفذ 3000.',
      });
    } finally {
      setTestingServer(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mobile-apps-modal-title"
    >
      <div className="w-full max-w-2xl rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden my-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Smartphone className="w-5 h-5 text-teal-600 shrink-0" />
            <div>
              <h2
                id="mobile-apps-modal-title"
                className="text-base font-bold text-slate-900 dark:text-slate-100"
              >
                تطبيق الهاتف الأصلي — Android (APK) و iOS (IPA)
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                مبني عبر Capacitor مع خط بناء GitHub Actions جاهز وتوزيع محلي عبر الشبكة.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق نافذة تطبيق الهاتف"
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode Tabs */}
        <div className="px-6 pt-4">
          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setActiveTab('download')}
              className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors ${
                activeTab === 'download'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              تنزيل وبناء حزم APK / IPA
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('server')}
              className={`flex-1 py-2 text-xs font-bold rounded-md transition-colors ${
                activeTab === 'server'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              إعداد خادم الشبكة المحلية (داخل APK / IPA)
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5 max-h-[75vh] overflow-y-auto">
          {activeTab === 'download' ? (
            <>
              {/* Two-column APK & IPA Release Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Android APK Card */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 flex flex-col justify-between gap-4">
                  <div>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span className="font-bold text-emerald-700 dark:text-emerald-400">
                        Android (.apk)
                      </span>
                      <span className="font-mono">edu.dbl.campus</span>
                    </div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1.5">
                      حزمة الأندرويد المباشرة (APK)
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                      تعمل على هواتف Android 8+ مع دعم الاتصال المباشر بخادم الدفعة عبر Wi-Fi المحلي.
                    </p>

                    {!loading && releases?.apk.available && (
                      <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 space-y-1">
                        <div>
                          الحجم:{' '}
                          <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
                            {formatBytes(releases.apk.sizeBytes)}
                          </span>
                        </div>
                        <div className="truncate" title={releases.apk.sha256 || ''}>
                          SHA-256:{' '}
                          <span className="font-mono">{releases.apk.sha256?.slice(0, 16)}...</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    {releases?.apk.available ? (
                      <div className="flex items-center gap-2">
                        <a
                          href={buildApiUrl('/api/mobile/download/apk')}
                          download="DBL-Campus-Android.apk"
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg bg-teal-600 text-white hover:bg-teal-700 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>تنزيل APK الآن</span>
                        </a>
                        {isRepresentative && (
                          <button
                            type="button"
                            onClick={() => handleDeletePackage('apk')}
                            aria-label="حذف ملف APK"
                            className="p-2 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
                        لم يُرفع ملف APK على الخادم المحلي بعد — أنشئه بضغطة زر من GitHub Actions أدناه.
                      </p>
                    )}

                    {isRepresentative && (
                      <label className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                        <Upload className="w-3.5 h-3.5" />
                        <span>
                          {uploading === 'apk'
                            ? 'جاري رفع ملف APK...'
                            : 'رفع ملف APK لتوزيعه على الطلاب'}
                        </span>
                        <input
                          type="file"
                          accept=".apk,application/vnd.android.package-archive"
                          onChange={(e) => handleUploadPackage('apk', e)}
                          disabled={uploading !== null}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* iOS IPA Card */}
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 flex flex-col justify-between gap-4">
                  <div>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span className="font-bold text-sky-700 dark:text-sky-400">
                        iOS (.ipa)
                      </span>
                      <span className="font-mono">Xcode / AltStore</span>
                    </div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mt-1.5">
                      حزمة الآيفون والآيباد (IPA)
                    </h3>
                    <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">
                      جاهزة للتثبيت عبر AltStore أو Sideloadly أو التوقيع عبر Xcode وTestFlight.
                    </p>

                    {!loading && releases?.ipa.available && (
                      <div className="mt-3 pt-2.5 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 space-y-1">
                        <div>
                          الحجم:{' '}
                          <span className="font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-200">
                            {formatBytes(releases.ipa.sizeBytes)}
                          </span>
                        </div>
                        <div className="truncate" title={releases.ipa.sha256 || ''}>
                          SHA-256:{' '}
                          <span className="font-mono">{releases.ipa.sha256?.slice(0, 16)}...</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    {releases?.ipa.available ? (
                      <div className="flex items-center gap-2">
                        <a
                          href={buildApiUrl('/api/mobile/download/ipa')}
                          download="DBL-Campus-iOS.ipa"
                          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded-lg bg-slate-900 dark:bg-teal-600 text-white hover:opacity-90 transition-opacity"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>تنزيل IPA الآن</span>
                        </a>
                        {isRepresentative && (
                          <button
                            type="button"
                            onClick={() => handleDeletePackage('ipa')}
                            aria-label="حذف ملف IPA"
                            className="p-2 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
                        لم يُرفع ملف IPA على الخادم المحلي بعد — أنشئه مجاناً على خادم macOS في GitHub Actions.
                      </p>
                    )}

                    {isRepresentative && (
                      <label className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
                        <Upload className="w-3.5 h-3.5" />
                        <span>
                          {uploading === 'ipa'
                            ? 'جاري رفع ملف IPA...'
                            : 'رفع ملف IPA لتوزيعه على الطلاب'}
                        </span>
                        <input
                          type="file"
                          accept=".ipa,application/octet-stream"
                          onChange={(e) => handleUploadPackage('ipa', e)}
                          disabled={uploading !== null}
                          className="hidden"
                        />
                      </label>
                    )}
                  </div>
                </div>
              </div>

              {/* GitHub Actions Automated Build Pipeline Box */}
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-slate-100">
                    <GitBranch className="w-4 h-4 text-teal-600" />
                    <span>البناء السحابي التلقائي عبر GitHub Actions (بدون جهاز Mac أو Android Studio)</span>
                  </div>
                </div>
                <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                  يحتوي المشروع على مشروعي <strong>Android</strong> و<strong>iOS</strong> الأصليين (Capacitor) مع ملف البناء الآلي{' '}
                  <code dir="ltr" className="inline-block font-mono text-teal-700 dark:text-teal-400">
                    .github/workflows/build-mobile.yml
                  </code>
                  . عند رفع المشروع إلى GitHub وتشغيل سير العمل (أو إنشاء وسم إصدار مثل{' '}
                  <code dir="ltr" className="inline-block font-mono">
                    v1.0.0
                  </code>
                  )، يقوم GitHub تلقائياً ببناء وتصدير:
                </p>
                <div
                  dir="ltr"
                  className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-left font-mono text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/70 p-2.5 rounded-lg"
                >
                  <span>1. DBL-Campus-Android.apk (Ubuntu + Gradle)</span>
                  <span>2. DBL-Campus-iOS.ipa (macOS + Xcode)</span>
                </div>
                <p className="text-[11px] text-slate-500">
                  التفاصيل الكاملة وخطوات التثبيت عبر AltStore / Sideloadly / Android موثقة في ملف{' '}
                  <code dir="ltr" className="inline-block font-mono">
                    MOBILE_BUILD_GUIDE_AR.md
                  </code>
                  .
                </p>
              </div>

              {/* Detected LAN Server Addresses */}
              {releases && releases.lanUrls.length > 0 && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 p-4 space-y-2 text-xs">
                  <div className="flex items-center gap-2 font-bold text-slate-800 dark:text-slate-200">
                    <Globe className="w-4 h-4 text-teal-600" />
                    <span>عناوين الشبكة المحلية (LAN) لربط تطبيقات الطلاب بهذا الخادم:</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {releases.lanUrls.map((url) => (
                      <button
                        key={url}
                        type="button"
                        onClick={() => handleCopyText(url, 'عنوان الخادم')}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 font-mono text-xs hover:border-teal-500"
                      >
                        <Copy className="w-3.5 h-3.5 text-slate-400" />
                        <span dir="ltr">{url}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Server Connection Settings Tab (for native APK/IPA apps) */
            <form onSubmit={handleTestAndSaveServer} className="space-y-4 text-xs">
              <div className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 space-y-1.5">
                <div className="flex items-center gap-2 font-bold text-slate-900 dark:text-slate-100">
                  <Server className="w-4 h-4 text-teal-600" />
                  <span>ربط تطبيق الهاتف بخادم الدفعة على الشبكة المحلية</span>
                </div>
                <p className="text-slate-600 dark:text-slate-400 leading-relaxed">
                  عند تشغيل التطبيق من ملف <strong>APK</strong> أو <strong>IPA</strong> على هاتفك، أدخل عنوان خادم المندوب على شبكة Wi-Fi المحلية (مثل{' '}
                  <code className="font-mono" dir="ltr">
                    http://192.168.1.15:3000
                  </code>
                  ). اتركه فارغاً عند الاستخدام من المتصفح المباشر.
                </p>
              </div>

              <div>
                <label className="block font-semibold mb-1.5 text-slate-800 dark:text-slate-200">
                  عنوان الخادم المركزي (Server URL)
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  placeholder="http://192.168.1.15:3000"
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3.5 py-2.5 font-mono text-xs"
                />
              </div>

              {serverCheckStatus && (
                <div
                  role="status"
                  className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                    serverCheckStatus.ok
                      ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                      : 'bg-rose-50 dark:bg-rose-950/30 border-rose-300 dark:border-rose-800 text-rose-800 dark:text-rose-300'
                  }`}
                >
                  {serverCheckStatus.ok && <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
                  <span>{serverCheckStatus.message}</span>
                </div>
              )}

              <div className="flex items-center justify-between pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    saveServerBaseUrl('');
                    setServerUrlInput('');
                    setServerCheckStatus({
                      ok: true,
                      message: 'تمت إعادة الضبط للخادم الافتراضي.',
                    });
                  }}
                  className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
                >
                  إعادة للوضع الافتراضي
                </button>

                <button
                  type="submit"
                  disabled={testingServer}
                  className="px-4 py-2 rounded-lg bg-teal-600 text-white font-bold hover:bg-teal-700 disabled:opacity-60"
                >
                  {testingServer ? 'جاري فحص الاتصال...' : 'فحص الاتصال وحفظ الإعداد'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};
